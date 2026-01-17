import { z } from 'zod';

// User types
export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  time_zone: z.string(),
  role: z.enum(['user', 'admin']),
  created_at: z.date(),
  updated_at: z.date(),
});

export type User = z.infer<typeof UserSchema>;

export const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  time_zone: z.string().default('UTC'),
});

export type CreateUserInput = z.infer<typeof CreateUserSchema>;

// Meeting Type types
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

export type MeetingType = z.infer<typeof MeetingTypeSchema>;

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

export type CreateMeetingTypeInput = z.infer<typeof CreateMeetingTypeSchema>;

export const UpdateMeetingTypeSchema = CreateMeetingTypeSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export type UpdateMeetingTypeInput = z.infer<typeof UpdateMeetingTypeSchema>;

// Availability Rule types
export const AvailabilityRuleSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string(),
  end_time: z.string(),
  is_active: z.boolean(),
  created_at: z.date(),
});

export type AvailabilityRule = z.infer<typeof AvailabilityRuleSchema>;

export const CreateAvailabilityRuleSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'Time must be in HH:MM format'),
});

export type CreateAvailabilityRuleInput = z.infer<typeof CreateAvailabilityRuleSchema>;

export const BulkAvailabilitySchema = z.object({
  rules: z.array(CreateAvailabilityRuleSchema),
});

export type BulkAvailabilityInput = z.infer<typeof BulkAvailabilitySchema>;

// Booking types
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

export type Booking = z.infer<typeof BookingSchema>;

export const CreateBookingSchema = z.object({
  meeting_type_id: z.string().uuid(),
  start_time: z.string().datetime(), // ISO 8601 format
  invitee_name: z.string().min(1),
  invitee_email: z.string().email(),
  invitee_timezone: z.string(),
  notes: z.string().optional(),
});

export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

export const RescheduleBookingSchema = z.object({
  new_start_time: z.string().datetime(),
});

export type RescheduleBookingInput = z.infer<typeof RescheduleBookingSchema>;

export const CancelBookingSchema = z.object({
  reason: z.string().optional(),
});

export type CancelBookingInput = z.infer<typeof CancelBookingSchema>;

// Time slot type
export interface TimeSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

// Email notification types
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

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

// Availability slots query params
export const AvailabilitySlotsQuerySchema = z.object({
  meeting_type_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  timezone: z.string().optional().default('UTC'),
});

export type AvailabilitySlotsQuery = z.infer<typeof AvailabilitySlotsQuerySchema>;

// Booking with related data
export interface BookingWithDetails extends Booking {
  meeting_type_name: string;
  meeting_type_duration: number;
  host_name: string;
  host_email: string;
}

// Dashboard stats
export interface DashboardStats {
  total_bookings: number;
  upcoming_bookings: number;
  total_meeting_types: number;
  bookings_this_week: number;
  bookings_this_month: number;
}
