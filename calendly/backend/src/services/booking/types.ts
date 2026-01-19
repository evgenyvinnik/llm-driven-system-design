/**
 * Shared types for the booking service modules.
 *
 * @description Centralizes type definitions used across create, cancel, reschedule,
 * and notification modules. This module serves as the single source of truth for
 * booking-related TypeScript interfaces.
 *
 * @module services/booking/types
 */

import { type Booking, type BookingWithDetails, type DashboardStats } from '../../types/index.js';

/** Re-export core types from the main types module */
export { type Booking, type BookingWithDetails, type DashboardStats };

/**
 * Meeting type with associated user/host details.
 *
 * @description Used when fetching meeting type information for booking operations.
 * Combines meeting type configuration with host user details for complete context.
 *
 * @property {string} id - Unique identifier (UUID) of the meeting type
 * @property {string} user_id - UUID of the host user who owns this meeting type
 * @property {string} name - Display name of the meeting type (e.g., "30 Minute Meeting")
 * @property {string} slug - URL-friendly identifier for public booking links
 * @property {number} duration_minutes - Duration of the meeting in minutes
 * @property {number} buffer_before_minutes - Buffer time before meetings in minutes
 * @property {number} buffer_after_minutes - Buffer time after meetings in minutes
 * @property {number | null} max_bookings_per_day - Optional daily booking limit
 * @property {boolean} is_active - Whether this meeting type is available for booking
 * @property {string} user_name - Display name of the host user
 * @property {string} user_email - Email address of the host user
 */
export interface MeetingTypeWithUser {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  max_bookings_per_day: number | null;
  is_active: boolean;
  user_name: string;
  user_email: string;
}

/**
 * Meeting details included when publishing notifications.
 *
 * @description Contains the essential meeting type and host information needed
 * for notification messages sent to RabbitMQ or via email.
 *
 * @property {string} meeting_type_name - Display name of the meeting type
 * @property {string} meeting_type_id - UUID of the meeting type
 * @property {string} host_name - Display name of the host user
 * @property {string} host_email - Email address of the host user
 */
export interface MeetingDetails {
  meeting_type_name: string;
  meeting_type_id: string;
  host_name: string;
  host_email: string;
}

/**
 * Result of a booking creation operation.
 *
 * @description Returned by createBooking to indicate whether a new booking
 * was created or a cached result was returned (idempotency handling).
 *
 * @property {Booking} booking - The created or cached booking object
 * @property {boolean} cached - True if result was returned from idempotency cache
 *
 * @example
 * const result = await createBooking(input, idempotencyKey);
 * if (result.cached) {
 *   console.log('Returned existing booking from cache');
 * } else {
 *   console.log('Created new booking:', result.booking.id);
 * }
 */
export interface CreateBookingResult {
  booking: Booking;
  cached: boolean;
}

/**
 * Extended booking with meeting type and buffer time information.
 *
 * @description Used when querying bookings with joined meeting type data,
 * particularly for reschedule operations that need buffer time calculations.
 *
 * @extends Booking
 * @property {number} duration_minutes - Duration of the meeting in minutes
 * @property {number} buffer_before_minutes - Buffer time before the meeting
 * @property {number} buffer_after_minutes - Buffer time after the meeting
 * @property {string} meeting_type_name - Display name of the meeting type
 * @property {string} meeting_type_id - UUID of the meeting type
 * @property {string} host_name - Display name of the host user
 * @property {string} host_email - Email address of the host user
 */
export interface BookingWithMeetingDetails extends Booking {
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  meeting_type_name: string;
  meeting_type_id: string;
  host_name: string;
  host_email: string;
}
