// Type definitions for Ticketmaster backend

export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
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
  created_at: Date;
  updated_at: Date;
}

export interface VenueSection {
  id: string;
  venue_id: string;
  name: string;
  row_count: number;
  seats_per_row: number;
  base_price: number;
  section_type: 'vip' | 'premium' | 'standard' | 'economy';
  position_x: number;
  position_y: number;
  created_at: Date;
}

export interface Event {
  id: string;
  name: string;
  description: string | null;
  venue_id: string;
  artist: string | null;
  category: 'concert' | 'sports' | 'theater' | 'comedy' | 'other';
  event_date: Date;
  on_sale_date: Date;
  status: 'upcoming' | 'on_sale' | 'sold_out' | 'cancelled' | 'completed';
  total_capacity: number;
  available_seats: number;
  image_url: string | null;
  waiting_room_enabled: boolean;
  max_concurrent_shoppers: number;
  max_tickets_per_user: number;
  created_at: Date;
  updated_at: Date;
}

export interface EventWithVenue extends Event {
  venue: Venue;
}

export interface EventSeat {
  id: string;
  event_id: string;
  section: string;
  row: string;
  seat_number: string;
  price_tier: 'vip' | 'premium' | 'standard' | 'economy';
  price: number;
  status: 'available' | 'held' | 'sold';
  held_until: Date | null;
  held_by_session: string | null;
  order_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: string;
  user_id: string;
  event_id: string;
  status: 'pending' | 'completed' | 'cancelled' | 'refunded' | 'payment_failed';
  total_amount: number;
  payment_id: string | null;
  created_at: Date;
  completed_at: Date | null;
  updated_at: Date;
}

export interface OrderItem {
  id: string;
  order_id: string;
  seat_id: string;
  price: number;
  created_at: Date;
}

export interface Session {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
}

// API Response types
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

// Queue types
export interface QueueStatus {
  position: number;
  status: 'waiting' | 'active' | 'not_in_queue';
  estimated_wait_seconds: number;
}

// Reservation types
export interface Reservation {
  session_id: string;
  event_id: string;
  seat_ids: string[];
  total_price: number;
  expires_at: Date;
}

export interface SeatAvailability {
  section: string;
  available: number;
  total: number;
  min_price: number;
  max_price: number;
  seats: SeatInfo[];
}

export interface SeatInfo {
  id: string;
  row: string;
  seat_number: string;
  price: number;
  price_tier: string;
  status: 'available' | 'held' | 'sold';
}

// Request types
export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

export interface ReserveSeatsRequest {
  event_id: string;
  seat_ids: string[];
}

export interface CheckoutRequest {
  payment_method: string;
  card_last_four?: string;
}
