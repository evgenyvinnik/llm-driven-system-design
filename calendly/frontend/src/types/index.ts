export interface User {
  id: string;
  email: string;
  name: string;
  time_zone: string;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

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

export interface AvailabilityRule {
  id: string;
  user_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  is_active: boolean;
  created_at: string;
}

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

export interface TimeSlot {
  start: string;
  end: string;
}

export interface DashboardStats {
  total_bookings: number;
  upcoming_bookings: number;
  total_meeting_types: number;
  bookings_this_week: number;
  bookings_this_month: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: Array<{ path: string[]; message: string }>;
}
