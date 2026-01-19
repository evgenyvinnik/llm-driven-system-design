/**
 * Booking Queries Service
 *
 * Handles booking retrieval operations.
 */

import { query } from '../../models/db.js';
import { formatBooking } from './formatter.js';
import type { BookingWithDetails, BookingRow } from './types.js';

/**
 * @description Retrieves a single booking by its ID with full hotel and room type details.
 * Optionally filters by user ID for authorization purposes.
 *
 * The query joins the bookings table with hotels and room_types to provide
 * complete information for displaying booking details to users.
 *
 * @param {string} bookingId - The unique identifier of the booking
 * @param {string | null} [userId=null] - Optional user ID to filter by. If provided,
 *        only returns the booking if it belongs to this user. If null, returns
 *        the booking regardless of owner (admin use case).
 * @returns {Promise<BookingWithDetails | null>} The booking with hotel and room details,
 *          or null if not found (or doesn't belong to the specified user)
 *
 * @example
 * // Get a booking for a specific user (user authorization)
 * const booking = await getBookingById('booking-123', 'user-456');
 * if (booking) {
 *   console.log(`Staying at ${booking.hotelName}`);
 * }
 *
 * @example
 * // Get any booking (admin access)
 * const booking = await getBookingById('booking-123');
 */
export async function getBookingById(
  bookingId: string,
  userId: string | null = null
): Promise<BookingWithDetails | null> {
  let queryStr = `
    SELECT b.*, h.name as hotel_name, h.address as hotel_address, h.city as hotel_city,
           rt.name as room_type_name
    FROM bookings b
    JOIN hotels h ON b.hotel_id = h.id
    JOIN room_types rt ON b.room_type_id = rt.id
    WHERE b.id = $1
  `;
  const params: unknown[] = [bookingId];

  if (userId) {
    queryStr += ' AND b.user_id = $2';
    params.push(userId);
  }

  const result = await query<BookingRow>(queryStr, params);

  if (result.rows.length === 0 || !result.rows[0]) {
    return null;
  }

  const row = result.rows[0];
  return {
    ...formatBooking(row),
    hotelName: row.hotel_name,
    hotelAddress: row.hotel_address,
    hotelCity: row.hotel_city,
    roomTypeName: row.room_type_name,
  };
}

/**
 * @description Retrieves all bookings for a specific user with hotel and room details.
 * Results are ordered by creation date (most recent first).
 *
 * This function is typically used for displaying a user's booking history
 * or upcoming stays in their account dashboard.
 *
 * @param {string} userId - The unique identifier of the user
 * @param {string | null} [status=null] - Optional status filter (e.g., 'reserved',
 *        'confirmed', 'cancelled', 'expired'). If null, returns all bookings.
 * @returns {Promise<BookingWithDetails[]>} Array of bookings with hotel and room details,
 *          sorted by creation date descending
 *
 * @example
 * // Get all bookings for a user
 * const bookings = await getBookingsByUser('user-456');
 * console.log(`User has ${bookings.length} bookings`);
 *
 * @example
 * // Get only confirmed bookings
 * const confirmedBookings = await getBookingsByUser('user-456', 'confirmed');
 *
 * @example
 * // Display upcoming stays
 * const upcomingStays = await getBookingsByUser('user-456', 'confirmed');
 * upcomingStays.forEach(booking => {
 *   console.log(`${booking.hotelName} - Check-in: ${booking.checkIn}`);
 * });
 */
export async function getBookingsByUser(
  userId: string,
  status: string | null = null
): Promise<BookingWithDetails[]> {
  let queryStr = `
    SELECT b.*, h.name as hotel_name, h.address as hotel_address, h.city as hotel_city,
           h.images as hotel_images, rt.name as room_type_name
    FROM bookings b
    JOIN hotels h ON b.hotel_id = h.id
    JOIN room_types rt ON b.room_type_id = rt.id
    WHERE b.user_id = $1
  `;
  const params: unknown[] = [userId];

  if (status) {
    queryStr += ' AND b.status = $2';
    params.push(status);
  }

  queryStr += ' ORDER BY b.created_at DESC';

  const result = await query<BookingRow>(queryStr, params);

  return result.rows.map((row) => ({
    ...formatBooking(row),
    hotelName: row.hotel_name,
    hotelAddress: row.hotel_address,
    hotelCity: row.hotel_city,
    hotelImages: row.hotel_images,
    roomTypeName: row.room_type_name,
  }));
}

/**
 * @description Retrieves all bookings for a specific hotel (hotel admin dashboard).
 * Includes user information for each booking and supports filtering by status and date range.
 * Results are ordered by check-in date (ascending for operational planning).
 *
 * This function first verifies that the requesting user owns the hotel before
 * returning any booking data, providing authorization at the data layer.
 *
 * @param {string} hotelId - The unique identifier of the hotel
 * @param {string} ownerId - The ID of the user claiming to own the hotel (for authorization)
 * @param {string | null} [status=null] - Optional status filter (e.g., 'confirmed', 'reserved')
 * @param {string | null} [startDate=null] - Optional filter for bookings with check-in >= this date (YYYY-MM-DD)
 * @param {string | null} [endDate=null] - Optional filter for bookings with check-out <= this date (YYYY-MM-DD)
 * @returns {Promise<BookingWithDetails[]>} Array of bookings with guest and room details,
 *          sorted by check-in date ascending
 * @throws {Error} Throws 'Hotel not found or access denied' if:
 *         - The hotel doesn't exist
 *         - The hotel doesn't belong to the specified owner
 *
 * @example
 * // Get all bookings for a hotel
 * const bookings = await getBookingsByHotel('hotel-123', 'owner-456');
 *
 * @example
 * // Get confirmed bookings for next month
 * const bookings = await getBookingsByHotel(
 *   'hotel-123',
 *   'owner-456',
 *   'confirmed',
 *   '2024-04-01',
 *   '2024-04-30'
 * );
 * bookings.forEach(b => {
 *   console.log(`${b.userFirstName} ${b.userLastName} - ${b.roomTypeName}`);
 * });
 */
export async function getBookingsByHotel(
  hotelId: string,
  ownerId: string,
  status: string | null = null,
  startDate: string | null = null,
  endDate: string | null = null
): Promise<BookingWithDetails[]> {
  // Verify ownership
  const ownerCheck = await query<{ id: string }>(
    'SELECT id FROM hotels WHERE id = $1 AND owner_id = $2',
    [hotelId, ownerId]
  );

  if (ownerCheck.rows.length === 0) {
    throw new Error('Hotel not found or access denied');
  }

  let queryStr = `
    SELECT b.*, u.first_name, u.last_name, u.email as user_email,
           rt.name as room_type_name
    FROM bookings b
    JOIN users u ON b.user_id = u.id
    JOIN room_types rt ON b.room_type_id = rt.id
    WHERE b.hotel_id = $1
  `;
  const params: unknown[] = [hotelId];
  let paramIndex = 2;

  if (status) {
    queryStr += ` AND b.status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (startDate) {
    queryStr += ` AND b.check_in >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    queryStr += ` AND b.check_out <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  queryStr += ' ORDER BY b.check_in ASC';

  const result = await query<BookingRow>(queryStr, params);

  return result.rows.map((row) => ({
    ...formatBooking(row),
    userFirstName: row.first_name,
    userLastName: row.last_name,
    userEmail: row.user_email,
    roomTypeName: row.room_type_name,
  }));
}
