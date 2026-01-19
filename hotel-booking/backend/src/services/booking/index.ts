/**
 * Booking Service
 *
 * Main entry point that combines all booking-related modules.
 *
 * Handles all booking operations with:
 * - Idempotency to prevent double-booking
 * - Distributed locking for room selection
 * - Pessimistic database locking
 * - Metrics for monitoring and alerting
 * - Structured logging for debugging
 */

// Re-export all types
export type {
  CreateBookingData,
  BookingTransactionData,
  AvailabilityCheck,
  CalendarDay,
  Booking,
  BookingWithDetails,
  BookingRow,
  RoomTypeRow,
  BookingCountRow,
  PriceOverrideRow,
} from './types.js';

// Import functions from modules
import { checkAvailability, getAvailabilityCalendar } from './availability.js';
import { createBooking, executeBookingTransaction } from './reservation.js';
import { confirmBooking } from './confirmation.js';
import { cancelBooking, expireStaleReservations } from './cancellation.js';
import { getBookingById, getBookingsByUser, getBookingsByHotel } from './queries.js';
import { invalidateAvailabilityCache } from './cache.js';
import { formatBooking } from './formatter.js';

/**
 * @description Booking Service class that wraps all booking operations.
 * Provides a unified interface for all booking-related functionality while
 * maintaining backward compatibility with the original class-based interface.
 *
 * The service is exported as a singleton instance for convenience, but individual
 * functions are also exported for direct imports when preferred.
 *
 * @example
 * // Using the default export (class instance)
 * import bookingService from './services/booking';
 * const availability = await bookingService.checkAvailability(...);
 *
 * @example
 * // Using named exports (individual functions)
 * import { checkAvailability, createBooking } from './services/booking';
 * const availability = await checkAvailability(...);
 */
class BookingService {
  /**
   * @description Check room availability for a date range.
   * @see {@link checkAvailability} for full documentation
   */
  checkAvailability = checkAvailability;

  /**
   * @description Get availability calendar for a month.
   * @see {@link getAvailabilityCalendar} for full documentation
   */
  getAvailabilityCalendar = getAvailabilityCalendar;

  /**
   * @description Create a new booking with idempotency and distributed locking.
   * @see {@link createBooking} for full documentation
   */
  createBooking = createBooking;

  /**
   * @description Execute booking transaction with pessimistic locking (internal use).
   * @see {@link executeBookingTransaction} for full documentation
   * @internal
   */
  _executeBookingTransaction = executeBookingTransaction;

  /**
   * @description Confirm a reserved booking after payment.
   * @see {@link confirmBooking} for full documentation
   */
  confirmBooking = confirmBooking;

  /**
   * @description Cancel an existing booking.
   * @see {@link cancelBooking} for full documentation
   */
  cancelBooking = cancelBooking;

  /**
   * @description Expire stale reservations (for background jobs).
   * @see {@link expireStaleReservations} for full documentation
   */
  expireStaleReservations = expireStaleReservations;

  /**
   * @description Get a booking by ID with hotel and room details.
   * @see {@link getBookingById} for full documentation
   */
  getBookingById = getBookingById;

  /**
   * @description Get all bookings for a user.
   * @see {@link getBookingsByUser} for full documentation
   */
  getBookingsByUser = getBookingsByUser;

  /**
   * @description Get all bookings for a hotel (admin).
   * @see {@link getBookingsByHotel} for full documentation
   */
  getBookingsByHotel = getBookingsByHotel;

  /**
   * @description Invalidate availability cache for a date range.
   * @see {@link invalidateAvailabilityCache} for full documentation
   */
  invalidateAvailabilityCache = invalidateAvailabilityCache;

  /**
   * @description Format a database booking row to application format.
   * @see {@link formatBooking} for full documentation
   */
  formatBooking = formatBooking;
}

export default new BookingService();

// Also export individual functions for direct imports
export {
  checkAvailability,
  getAvailabilityCalendar,
  createBooking,
  executeBookingTransaction,
  confirmBooking,
  cancelBooking,
  expireStaleReservations,
  getBookingById,
  getBookingsByUser,
  getBookingsByHotel,
  invalidateAvailabilityCache,
  formatBooking,
};
