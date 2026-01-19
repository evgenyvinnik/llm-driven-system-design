/**
 * Airbnb Domain Types
 */

// User types
export interface User {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  bio?: string;
  phone?: string;
  avatar_url?: string;
  is_host: boolean;
  is_verified: boolean;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface UserPublic {
  id: number;
  email: string;
  name: string;
  bio?: string;
  phone?: string;
  avatar_url?: string;
  is_host: boolean;
  is_verified: boolean;
  role: 'user' | 'admin';
}

// Listing types
export interface Listing {
  id: number;
  host_id: number;
  title: string;
  description: string;
  property_type: 'house' | 'apartment' | 'room' | 'hotel';
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  latitude: number;
  longitude: number;
  price_per_night: number;
  cleaning_fee: number;
  service_fee: number;
  max_guests: number;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  amenities: string[];
  photos: string[];
  instant_book: boolean;
  is_active: boolean;
  rating: number;
  review_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ListingWithHost extends Listing {
  host: UserPublic;
}

// Availability types
export interface AvailabilityBlock {
  id: number;
  listing_id: number;
  start_date: Date;
  end_date: Date;
  is_blocked: boolean;
  price_override?: number;
  min_stay?: number;
  created_at: Date;
}

// Booking types
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export interface Booking {
  id: number;
  listing_id: number;
  guest_id: number;
  check_in: Date;
  check_out: Date;
  guests: number;
  total_price: number;
  status: BookingStatus;
  special_requests?: string;
  created_at: Date;
  updated_at: Date;
}

export interface BookingWithDetails extends Booking {
  listing: Listing;
  guest: UserPublic;
}

// Review types
export interface Review {
  id: number;
  booking_id: number;
  reviewer_id: number;
  reviewee_id: number;
  listing_id: number;
  rating: number;
  cleanliness_rating?: number;
  accuracy_rating?: number;
  check_in_rating?: number;
  communication_rating?: number;
  location_rating?: number;
  value_rating?: number;
  comment: string;
  is_host_review: boolean;
  is_visible: boolean;
  created_at: Date;
}

export interface ReviewWithDetails extends Review {
  reviewer: UserPublic;
}

// Message types
export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  content: string;
  is_read: boolean;
  created_at: Date;
}

export interface Conversation {
  id: number;
  listing_id: number;
  guest_id: number;
  host_id: number;
  last_message_at: Date;
  created_at: Date;
}

export interface ConversationWithDetails extends Conversation {
  listing: Listing;
  guest: UserPublic;
  host: UserPublic;
  messages: Message[];
  unread_count: number;
}

// Search types
export interface SearchFilters {
  city?: string;
  check_in?: string;
  check_out?: string;
  guests?: number;
  min_price?: number;
  max_price?: number;
  property_type?: string;
  amenities?: string[];
  instant_book?: boolean;
  latitude?: number;
  longitude?: number;
  radius_km?: number;
}

export interface SearchResult {
  listings: ListingWithHost[];
  total: number;
  page: number;
  per_page: number;
}

// Session types
export interface Session {
  userId: number;
  createdAt: string;
  expiresAt: Date;
}

// Queue message types
export interface BookingEvent {
  type: 'booking_created' | 'booking_confirmed' | 'booking_cancelled' | 'booking_completed';
  bookingId: number;
  listingId: number;
  guestId: number;
  hostId: number;
  timestamp: string;
}

export interface ReviewEvent {
  type: 'review_created';
  reviewId: number;
  bookingId: number;
  reviewerId: number;
  revieweeId: number;
  timestamp: string;
}

// API response types
export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// Audit types
export interface AuditLog {
  id: number;
  user_id: number;
  action: string;
  resource_type: string;
  resource_id: number;
  details: Record<string, unknown>;
  ip_address?: string;
  created_at: Date;
}
