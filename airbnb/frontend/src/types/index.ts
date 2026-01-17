export interface User {
  id: number;
  email: string;
  name: string;
  avatar_url?: string;
  bio?: string;
  phone?: string;
  is_host: boolean;
  is_verified: boolean;
  role: 'user' | 'admin';
}

export interface Listing {
  id: number;
  host_id: number;
  title: string;
  description?: string;
  latitude: number;
  longitude: number;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  country?: string;
  postal_code?: string;
  property_type: string;
  room_type: 'entire_place' | 'private_room' | 'shared_room';
  max_guests: number;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  amenities: string[];
  house_rules?: string;
  price_per_night: number;
  cleaning_fee: number;
  service_fee_percent: number;
  rating?: number;
  review_count: number;
  instant_book: boolean;
  minimum_nights: number;
  maximum_nights: number;
  cancellation_policy: 'flexible' | 'moderate' | 'strict';
  is_active: boolean;
  created_at: string;
  host_name?: string;
  host_avatar?: string;
  host_bio?: string;
  host_verified?: boolean;
  host_since?: string;
  host_response_rate?: number;
  primary_photo?: string;
  photos?: Photo[];
  reviews?: Review[];
}

export interface Photo {
  id: number;
  listing_id: number;
  url: string;
  caption?: string;
  display_order: number;
}

export interface Booking {
  id: number;
  listing_id: number;
  guest_id: number;
  check_in: string;
  check_out: string;
  guests: number;
  nights: number;
  price_per_night: number;
  cleaning_fee: number;
  service_fee: number;
  total_price: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'declined';
  guest_message?: string;
  host_response?: string;
  cancelled_by?: 'guest' | 'host';
  cancelled_at?: string;
  created_at: string;
  listing_title?: string;
  listing_city?: string;
  listing_state?: string;
  listing_country?: string;
  listing_photo?: string;
  listing_photos?: string[];
  host_id?: number;
  host_name?: string;
  host_avatar?: string;
  host_phone?: string;
  guest_name?: string;
  guest_avatar?: string;
  guest_email?: string;
  guest_phone?: string;
  address_line1?: string;
  house_rules?: string;
}

export interface Review {
  id: number;
  booking_id: number;
  author_id: number;
  author_type: 'host' | 'guest';
  rating: number;
  cleanliness_rating?: number;
  communication_rating?: number;
  location_rating?: number;
  value_rating?: number;
  content?: string;
  is_public: boolean;
  created_at: string;
  author_name?: string;
  author_avatar?: string;
  listing_title?: string;
}

export interface Conversation {
  id: number;
  listing_id?: number;
  booking_id?: number;
  host_id: number;
  guest_id: number;
  listing_title?: string;
  listing_photo?: string;
  host_name?: string;
  host_avatar?: string;
  guest_name?: string;
  guest_avatar?: string;
  last_message?: string;
  last_message_at?: string;
  unread_count?: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  sender_id: number;
  content: string;
  is_read: boolean;
  created_at: string;
  sender_name?: string;
  sender_avatar?: string;
}

export interface AvailabilityBlock {
  id: number;
  listing_id: number;
  start_date: string;
  end_date: string;
  status: 'available' | 'blocked' | 'booked';
  price_per_night?: number;
  booking_id?: number;
}

export interface SearchParams {
  latitude?: number;
  longitude?: number;
  radius?: number;
  check_in?: string;
  check_out?: string;
  guests?: number;
  min_price?: number;
  max_price?: number;
  property_type?: string;
  room_type?: string;
  amenities?: string[];
  instant_book?: boolean;
  bedrooms?: number;
  beds?: number;
  bathrooms?: number;
  sort?: 'relevance' | 'price_low' | 'price_high' | 'rating' | 'distance';
}

export interface PricingDetails {
  nights: number;
  pricePerNight: number;
  subtotal: number;
  cleaningFee: number;
  serviceFee: number;
  total: number;
}
