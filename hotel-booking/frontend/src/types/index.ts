export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: 'user' | 'hotel_admin' | 'admin';
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface Hotel {
  id: string;
  ownerId?: string;
  name: string;
  description: string;
  address: string;
  city: string;
  state?: string;
  country: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  starRating: number;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  cancellationPolicy: string;
  images: string[];
  isActive: boolean;
  avgRating: number;
  reviewCount: number;
  roomTypes?: RoomType[];
  createdAt?: string;
  updatedAt?: string;
  // Search result fields
  startingPrice?: number;
  availableRoomTypes?: AvailableRoomType[];
}

export interface RoomType {
  id: string;
  hotelId: string;
  name: string;
  description: string;
  capacity: number;
  bedType: string;
  totalCount: number;
  basePrice: number;
  amenities: string[];
  images: string[];
  sizeSqm?: number;
  isActive: boolean;
  // Availability fields
  availability?: {
    available: boolean;
    availableRooms: number;
    totalRooms: number;
    requestedRooms: number;
  };
  totalPrice?: number;
  nights?: number;
  pricePerNight?: number;
}

export interface AvailableRoomType {
  id: string;
  capacity: number;
  basePrice: number;
  availableRooms: number;
}

export interface Booking {
  id: string;
  userId: string;
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  guestCount: number;
  totalPrice: number;
  status: 'pending' | 'reserved' | 'confirmed' | 'cancelled' | 'completed' | 'expired';
  paymentId?: string;
  reservedUntil?: string;
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone?: string;
  specialRequests?: string;
  createdAt: string;
  updatedAt: string;
  // Joined fields
  hotelName?: string;
  hotelAddress?: string;
  hotelCity?: string;
  hotelImages?: string[];
  roomTypeName?: string;
}

export interface Review {
  id: string;
  bookingId: string;
  userId: string;
  hotelId: string;
  rating: number;
  title?: string;
  content?: string;
  createdAt: string;
  authorFirstName?: string;
  authorLastName?: string;
}

export interface ReviewStats {
  totalReviews: number;
  avgRating: number;
  distribution: {
    1: number;
    2: number;
    3: number;
    4: number;
    5: number;
  };
}

export interface AvailabilityDay {
  date: string;
  available: number;
  total: number;
  booked: number;
  price: number;
}

export interface SearchParams {
  city?: string;
  country?: string;
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  rooms?: number;
  minStars?: number;
  maxPrice?: number;
  minPrice?: number;
  amenities?: string[];
  sortBy?: 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'stars';
  page?: number;
  limit?: number;
}

export interface SearchResult {
  hotels: Hotel[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PricingInfo {
  basePrice: number;
  prices: { date: string; price: number }[];
  totalPrice: number;
}
