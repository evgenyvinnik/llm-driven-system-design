import { z } from 'zod';

/**
 * Zod schema for validating User objects.
 * Defines the structure for user accounts including authentication and profile data.
 */
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  time_zone: z.string(),
  role: z.enum(['user', 'admin']),
  created_at: z.date(),
  updated_at: z.date(),
});

/** User type inferred from UserSchema */
export type User = z.infer<typeof UserSchema>;

/**
 * Zod schema for user registration input validation.
 * Used when creating new user accounts.
 */
export const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  time_zone: z.string().default('UTC'),
});

/** Input type for user creation */
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

/**
 * Zod schema for MeetingType objects.
 * Meeting types define the configurable scheduling options hosts offer to invitees,
 * including duration, buffer times, and daily booking limits.
 */
export const MeetingTypeSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  description: z.string().nullable(),
  duration_minutes: z.number().int().positive(),
  buffer_before_minutes: z.number().int().min(0),
  buffer_after_minutes: z.number().int().min(0),
  max_bookings_per_day: z.number().int().positive().nullable(),
  color: z.string(),
  is_active: z.boolean(),
  created_at: z.date(),
  updated_at: z.date(),
});

/** MeetingType type inferred from MeetingTypeSchema */
export type MeetingType = z.infer<typeof MeetingTypeSchema>;

/**
 * Zod schema for creating a new meeting type.
 * Enforces slug format, positive duration, and valid hex color codes.
 */
export const CreateMeetingTypeSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().optional(),
  duration_minutes: z.number().int().positive().default(30),
  buffer_before_minutes: z.number().int().min(0).default(0),
  buffer_after_minutes: z.number().int().min(0).default(0),
  max_bookings_per_day: z.number().int().positive().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3B82F6'),
});

/** Input type for creating a meeting type */
export type CreateMeetingTypeInput = z.infer<typeof CreateMeetingTypeSchema>;

/**
 * Zod schema for updating an existing meeting type.
 * All fields are optional; also allows toggling is_active status.
 */
export const UpdateMeetingTypeSchema = CreateMeetingTypeSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export type UpdateMeetingTypeInput = z.infer<typeof UpdateMeetingTypeSchema>;

/**
 * Zod schema for AvailabilityRule objects.
 * Availability rules define weekly recurring time windows when a host is available.
 * Day of week is 0-6 (Sunday-Saturday).
 */
export const AvailabilityRuleSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string(),
  end_time: z.string(),
  is_active: z.boolean(),
  created_at: z.date(),
});

/** AvailabilityRule type inferred from schema */
export type AvailabilityRule = z.infer<typeof AvailabilityRuleSchema>;

/**
 * Zod schema for creating a single availability rule.
 * Times must be in HH:MM format (24-hour).
 */
export const CreateAvailabilityRuleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
});

/** Input type for creating an availability rule */
export type CreateAvailabilityRuleInput = z.infer<typeof CreateAvailabilityRuleSchema>;

/**
 * Zod schema for bulk updating availability rules.
 * Used to replace all existing rules with a new set.
 */
export const BulkAvailabilitySchema = z.object({
  rules: z.array(CreateAvailabilityRuleSchema),
});

export type BulkAvailabilityInput = z.infer<typeof BulkAvailabilitySchema>;

/**
 * Zod schema for Booking objects.
 * Bookings represent scheduled meetings between hosts and invitees.
 * Includes optimistic locking via version field to prevent race conditions.
 */
export const BookingSchema = z.object({
  id: z.string().uuid(),
  meeting_type_id: z.string().uuid(),
  host_user_id: z.string().uuid(),
  invitee_name: z.string().min(1),
  invitee_email: z.string().email(),
  start_time: z.date(),
  end_time: z.date(),
  invitee_timezone: z.string(),
  status: z.enum(['confirmed', 'cancelled', 'rescheduled']),
  cancellation_reason: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.date(),
  updated_at: z.date(),
  version: z.number().int(),
});

/** Booking type inferred from schema */
export type Booking = z.infer<typeof BookingSchema>;

/**
 * Zod schema for creating a new booking.
 * Validates that start_time is in ISO 8601 format.
 */
export const CreateBookingSchema = z.object({
  meeting_type_id: z.string().uuid(),
  start_time: z.string().datetime(), // ISO 8601 format
  invitee_name: z.string().min(1),
  invitee_email: z.string().email(),
  invitee_timezone: z.string(),
  notes: z.string().optional(),
});

/** Input type for creating a booking */
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

/**
 * Zod schema for rescheduling a booking.
 * Requires a new start time in ISO 8601 format.
 */
export const RescheduleBookingSchema = z.object({
  new_start_time: z.string().datetime(),
});

export type RescheduleBookingInput = z.infer<typeof RescheduleBookingSchema>;

/**
 * Zod schema for cancelling a booking.
 * Reason is optional but recommended for user experience.
 */
export const CancelBookingSchema = z.object({
  reason: z.string().optional(),
});

export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

/**
 * Represents a bookable time slot.
 * Times are in ISO 8601 format for consistent handling across timezones.
 */
export interface TimeSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

/**
 * Record of an email notification sent by the system.
 * Used for tracking notification history and debugging delivery issues.
 */
export interface EmailNotification {
  id: string;
  booking_id: string;
  recipient_email: string;
  notification_type: 'confirmation' | 'reminder' | 'cancellation' | 'reschedule';
  subject: string;
  body: string;
  sent_at: Date;
  status: 'sent' | 'failed';
}

/**
 * Standard API response wrapper for consistent frontend handling.
 * @template T - The type of data returned on success
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

/**
 * Zod schema for availability slots query parameters.
 * Used when fetching available time slots for a specific meeting type and date.
 */
export const AvailabilitySlotsQuerySchema = z.object({
  meeting_type_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  timezone: z.string().optional().default('UTC'),
});

export type AvailabilitySlotsQuery = z.infer<typeof AvailabilitySlotsQuerySchema>;

/**
 * Extended booking type with related entity details.
 * Used for displaying full booking information in the UI.
 */
export interface BookingWithDetails extends Booking {
  meeting_type_name: string;
  meeting_type_duration: number;
  host_name: string;
  host_email: string;
}

/**
 * Aggregated statistics for the user dashboard.
 * Provides quick insights into booking activity.
 */
export interface DashboardStats {
  total_bookings: number;
  upcoming_bookings: number;
  total_meeting_types: number;
  bookings_this_week: number;
  bookings_this_month: number;
}
