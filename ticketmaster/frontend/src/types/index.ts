// Types for the Ticketmaster frontend

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export interface Venue {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string | null;
  country: string;
  capacity: number;
  image_url: string | null;
}

export interface Event {
  id: string;
  name: string;
  description: string | null;
  venue_id: string;
  artist: string | null;
  category: 'concert' | 'sports' | 'theater' | 'comedy' | 'other';
  event_date: string;
  on_sale_date: string;
  status: 'upcoming' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';
  total_capacity: number;
  available_seats: number;
  image_url: string | null;
  waiting_room_enabled: boolean;
  max_concurrent_shoppers: number;
  max_tickets_per_user: number;
  venue: Venue;
}

export interface Seat {
  id: string;
  row: string;
  seat_number: string;
  price: number;
  price_tier: 'vip' | 'premium' | 'standard' | 'economy';
  status: 'available' | 'held' | 'sold';
}

export interface SectionAvailability {
  section: string;
  available: number;
  total: number;
  min_price: number;
  max_price: number;
  seats: Seat[];
}

export interface Reservation {
  event_id: string;
  seats: EventSeat[];
  total_price: number;
  expires_at: string;
}

export interface EventSeat {
  id: string;
  event_id: string;
  section: string;
  row: string;
  seat_number: string;
  price_tier: string;
  price: number;
  status: string;
}

export interface Order {
  id: string;
  user_id: string;
  event_id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'refunded' | 'payment_failed';
  total_amount: number;
  payment_id: string | null;
  created_at: string;
  completed_at: string | null;
  event_name?: string;
  event_date?: string;
  artist?: string;
  venue_name?: string;
  venue_city?: string;
}

export interface QueueStatus {
  position: number;
  status: 'waiting' | 'active' | 'not_in_queue';
  estimated_wait_seconds: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
