import type { ApiResponse, User, MeetingType, Booking, AvailabilityRule, TimeSlot, DashboardStats } from '../types';

const API_BASE = '/api';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  const data = await response.json();
  return data;
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    fetchApi<User>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string, time_zone: string) =>
    fetchApi<User>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name, time_zone }),
    }),

  logout: () =>
    fetchApi<void>('/auth/logout', { method: 'POST' }),

  me: () =>
    fetchApi<User>('/auth/me'),
};

// Meeting Types API
export const meetingTypesApi = {
  list: (activeOnly = false) =>
    fetchApi<MeetingType[]>(`/meeting-types${activeOnly ? '?active=true' : ''}`),

  get: (id: string) =>
    fetchApi<MeetingType>(`/meeting-types/${id}`),

  create: (data: {
    name: string;
    slug: string;
    description?: string;
    duration_minutes: number;
    buffer_before_minutes?: number;
    buffer_after_minutes?: number;
    max_bookings_per_day?: number;
    color?: string;
  }) =>
    fetchApi<MeetingType>('/meeting-types', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<{
    name: string;
    slug: string;
    description: string;
    duration_minutes: number;
    buffer_before_minutes: number;
    buffer_after_minutes: number;
    max_bookings_per_day: number;
    color: string;
    is_active: boolean;
  }>) =>
    fetchApi<MeetingType>(`/meeting-types/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    fetchApi<void>(`/meeting-types/${id}`, { method: 'DELETE' }),
};

// Availability API
export const availabilityApi = {
  getRules: () =>
    fetchApi<AvailabilityRule[]>('/availability/rules'),

  setRules: (rules: Array<{ day_of_week: number; start_time: string; end_time: string }>) =>
    fetchApi<AvailabilityRule[]>('/availability/rules', {
      method: 'POST',
      body: JSON.stringify({ rules }),
    }),

  getSlots: (meetingTypeId: string, date: string, timezone: string) =>
    fetchApi<{ date: string; timezone: string; slots: TimeSlot[] }>(
      `/availability/slots?meeting_type_id=${meetingTypeId}&date=${date}&timezone=${encodeURIComponent(timezone)}`
    ),

  getAvailableDates: (meetingTypeId: string, timezone: string, daysAhead = 30) =>
    fetchApi<{ available_dates: string[] }>(
      `/availability/dates?meeting_type_id=${meetingTypeId}&timezone=${encodeURIComponent(timezone)}&days_ahead=${daysAhead}`
    ),
};

// Bookings API
export const bookingsApi = {
  list: (status?: string, upcoming = false) => {
    const params = new URLSearchParams();
    if (status) params.append('status', status);
    if (upcoming) params.append('upcoming', 'true');
    return fetchApi<Booking[]>(`/bookings?${params.toString()}`);
  },

  get: (id: string) =>
    fetchApi<Booking>(`/bookings/${id}`),

  getStats: () =>
    fetchApi<DashboardStats>('/bookings/stats'),

  create: (data: {
    meeting_type_id: string;
    start_time: string;
    invitee_name: string;
    invitee_email: string;
    invitee_timezone: string;
    notes?: string;
  }) =>
    fetchApi<Booking>('/bookings', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  reschedule: (id: string, newStartTime: string) =>
    fetchApi<Booking>(`/bookings/${id}/reschedule`, {
      method: 'PUT',
      body: JSON.stringify({ new_start_time: newStartTime }),
    }),

  cancel: (id: string, reason?: string) =>
    fetchApi<Booking>(`/bookings/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),
};

// Admin API
export const adminApi = {
  getStats: () =>
    fetchApi<{
      users: number;
      meeting_types: number;
      bookings: { total: number; confirmed: number; cancelled: number; upcoming: number };
      emails_sent: number;
    }>('/admin/stats'),

  getUsers: () =>
    fetchApi<User[]>('/admin/users'),

  getBookings: (limit = 100, status?: string) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.append('status', status);
    return fetchApi<Booking[]>(`/admin/bookings?${params.toString()}`);
  },

  getEmails: (limit = 100) =>
    fetchApi<Array<{
      id: string;
      booking_id: string;
      recipient_email: string;
      notification_type: string;
      subject: string;
      sent_at: string;
      status: string;
    }>>(`/admin/emails?limit=${limit}`),

  deleteUser: (id: string) =>
    fetchApi<void>(`/admin/users/${id}`, { method: 'DELETE' }),
};
