/**
 * User account information.
 * Represents both hosts and admin users in the system.
 */
export interface User {
  id: string;
  email: string;
  name: string;
  time_zone: string;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

/**
 * Meeting type (event type) configuration.
 * Defines scheduling options that hosts offer to invitees.
 */
export interface MeetingType {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  max_bookings_per_day: number | null;
  color: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Extended fields when fetched with user
  user_name?: string;
  user_email?: string;
  user_timezone?: string;
}

/**
 * Weekly recurring availability rule.
 * Defines when a host is available for meetings.
 */
export interface AvailabilityRule {
  id: string;
  user_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
  created_at: string;
}

/**
 * Scheduled meeting between host and invitee.
 * Includes status tracking and optional notes.
 */
export interface Booking {
  id: string;
  meeting_type_id: string;
  host_user_id: string;
  invitee_name: string;
  invitee_email: string;
  start_time: string;
  end_time: string;
  invitee_timezone: string;
  status: 'confirmed' | 'cancelled' | 'rescheduled';
  cancellation_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  // Extended fields
  meeting_type_name?: string;
  meeting_type_duration?: number;
  host_name?: string;
  host_email?: string;
}

/**
 * Available time slot for booking.
 * Times are in ISO 8601 format.
 */
export interface TimeSlot {
  start: string;
  end: string;
}

/**
 * Dashboard statistics for a host.
 * Aggregated booking counts for display.
 */
export interface DashboardStats {
  total_bookings: number;
  upcoming_bookings: number;
  total_meeting_types: number;
  bookings_this_week: number;
  bookings_this_month: number;
}

/**
 * Standard API response wrapper.
 * All API endpoints return this structure for consistent error handling.
 * @template T - The type of data returned on success
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: Array<{ path: string[]; message: string }>;
}
