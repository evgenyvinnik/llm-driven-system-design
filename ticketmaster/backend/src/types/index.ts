/**
 * Type definitions for Ticketmaster backend.
 * These types define the core domain entities for the event ticketing system.
 */

/**
 * Represents a registered user in the system.
 * Users can browse events, purchase tickets, and view their order history.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a physical venue where events take place.
 * Venues contain sections with seats that can be sold for events.
 */
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

/**
 * Represents a section within a venue (e.g., VIP, Orchestra, Balcony).
 * Each section has a specific layout and pricing tier.
 */
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

/**
 * Represents a scheduled event (concert, sports game, theater show, etc.).
 * Events are associated with venues and have configurable ticket sale settings.
 */
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

/**
 * Extended Event interface that includes the full venue details.
 * Used in API responses to provide complete event information.
 */
export interface EventWithVenue extends Event {
  venue: Venue;
}

/**
 * Represents an individual seat for a specific event.
 * Seats can be available, held (temporarily reserved), or sold.
 * The held state is used during checkout to prevent double-booking.
 */
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

/**
 * Represents a completed or pending ticket purchase.
 * Orders track the payment status and link users to their purchased seats.
 */
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

/**
 * Represents a single seat within an order.
 * Each order can contain multiple seats (order items).
 */
export interface OrderItem {
  id: string;
  order_id: string;
  seat_id: string;
  price: number;
  created_at: Date;
}

/**
 * Represents an authenticated user session.
 * Sessions are stored in both PostgreSQL (persistence) and Redis (fast lookup).
 */
export interface Session {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
}

/**
 * Standard API response wrapper for single-item responses.
 * @template T - The type of data being returned
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * API response wrapper for paginated list responses.
 * Includes pagination metadata for client-side navigation.
 * @template T - The type of items in the data array
 */
export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Represents a user's position in the virtual waiting room queue.
 * Used to manage traffic during high-demand event sales.
 */
export interface QueueStatus {
  position: number;
  status: 'waiting' | 'active' | 'not_in_queue';
  estimated_wait_seconds: number;
}

/**
 * Represents a temporary seat reservation during checkout.
 * Seats are held for a limited time (typically 10 minutes) before expiring.
 */
export interface Reservation {
  session_id: string;
  event_id: string;
  seat_ids: string[];
  total_price: number;
  expires_at: Date;
}

/**
 * Aggregated availability information for a venue section.
 * Includes pricing range and list of individual seats.
 */
export interface SeatAvailability {
  section: string;
  available: number;
  total: number;
  min_price: number;
  max_price: number;
  seats: SeatInfo[];
}

/**
 * Minimal seat information for display in the seat map UI.
 */
export interface SeatInfo {
  id: string;
  row: string;
  seat_number: string;
  price: number;
  price_tier: string;
  status: 'available' | 'held' | 'sold';
}

/**
 * Request payload for user login.
 */
export interface LoginRequest {
  email: string;
  password: string;
}

/**
 * Request payload for new user registration.
 */
export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

/**
 * Request payload for reserving seats during checkout.
 */
export interface ReserveSeatsRequest {
  event_id: string;
  seat_ids: string[];
}

/**
 * Request payload for completing a purchase.
 */
export interface CheckoutRequest {
  payment_method: string;
  card_last_four?: string;
}
