import type { AuthResponse, User, Hotel, RoomType, Booking, Review, ReviewStats, SearchResult, SearchParams, AvailabilityDay, PricingInfo } from '@/types';

const API_BASE = '/api/v1';

class ApiService {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Auth
  async register(data: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    role?: string;
  }): Promise<AuthResponse> {
    return this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' });
  }

  async getMe(): Promise<{ user: User }> {
    return this.request('/auth/me');
  }

  // Hotels
  async searchHotels(params: SearchParams): Promise<SearchResult> {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        if (Array.isArray(value)) {
          query.set(key, value.join(','));
        } else {
          query.set(key, String(value));
        }
      }
    });
    return this.request(`/hotels/search?${query.toString()}`);
  }

  async getHotel(hotelId: string, checkIn?: string, checkOut?: string, guests?: number): Promise<Hotel> {
    const query = new URLSearchParams();
    if (checkIn) query.set('checkIn', checkIn);
    if (checkOut) query.set('checkOut', checkOut);
    if (guests) query.set('guests', String(guests));
    const queryString = query.toString();
    return this.request(`/hotels/${hotelId}${queryString ? `?${queryString}` : ''}`);
  }

  async createHotel(data: Partial<Hotel>): Promise<Hotel> {
    return this.request('/hotels', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateHotel(hotelId: string, data: Partial<Hotel>): Promise<Hotel> {
    return this.request(`/hotels/${hotelId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteHotel(hotelId: string): Promise<void> {
    await this.request(`/hotels/${hotelId}`, { method: 'DELETE' });
  }

  async getMyHotels(): Promise<Hotel[]> {
    return this.request('/hotels/admin/my-hotels');
  }

  // Room Types
  async getRoomTypes(hotelId: string): Promise<RoomType[]> {
    return this.request(`/hotels/${hotelId}/rooms`);
  }

  async createRoomType(hotelId: string, data: Partial<RoomType>): Promise<RoomType> {
    return this.request(`/hotels/${hotelId}/rooms`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateRoomType(roomTypeId: string, data: Partial<RoomType>): Promise<RoomType> {
    return this.request(`/hotels/rooms/${roomTypeId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteRoomType(roomTypeId: string): Promise<void> {
    await this.request(`/hotels/rooms/${roomTypeId}`, { method: 'DELETE' });
  }

  async setPriceOverride(roomTypeId: string, date: string, price: number): Promise<void> {
    await this.request(`/hotels/rooms/${roomTypeId}/pricing`, {
      method: 'POST',
      body: JSON.stringify({ date, price }),
    });
  }

  async getPricing(roomTypeId: string, checkIn: string, checkOut: string): Promise<PricingInfo> {
    return this.request(`/hotels/rooms/${roomTypeId}/pricing?checkIn=${checkIn}&checkOut=${checkOut}`);
  }

  // Reviews
  async getReviews(hotelId: string, page = 1, limit = 10): Promise<{ reviews: Review[]; total: number; page: number; limit: number; totalPages: number }> {
    return this.request(`/hotels/${hotelId}/reviews?page=${page}&limit=${limit}`);
  }

  async getReviewStats(hotelId: string): Promise<ReviewStats> {
    return this.request(`/hotels/${hotelId}/reviews/stats`);
  }

  // Bookings
  async checkAvailability(hotelId: string, roomTypeId: string, checkIn: string, checkOut: string, rooms = 1): Promise<{
    available: boolean;
    availableRooms: number;
    totalRooms: number;
    requestedRooms: number;
  }> {
    return this.request(`/bookings/availability?hotelId=${hotelId}&roomTypeId=${roomTypeId}&checkIn=${checkIn}&checkOut=${checkOut}&rooms=${rooms}`);
  }

  async getAvailabilityCalendar(hotelId: string, roomTypeId: string, year: number, month: number): Promise<AvailabilityDay[]> {
    return this.request(`/bookings/availability/calendar?hotelId=${hotelId}&roomTypeId=${roomTypeId}&year=${year}&month=${month}`);
  }

  async createBooking(data: {
    hotelId: string;
    roomTypeId: string;
    checkIn: string;
    checkOut: string;
    roomCount: number;
    guestCount: number;
    guestFirstName: string;
    guestLastName: string;
    guestEmail: string;
    guestPhone?: string;
    specialRequests?: string;
  }): Promise<Booking> {
    return this.request('/bookings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async confirmBooking(bookingId: string, paymentId?: string): Promise<Booking> {
    return this.request(`/bookings/${bookingId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ paymentId }),
    });
  }

  async cancelBooking(bookingId: string): Promise<Booking> {
    return this.request(`/bookings/${bookingId}/cancel`, {
      method: 'POST',
    });
  }

  async getBooking(bookingId: string): Promise<Booking> {
    return this.request(`/bookings/${bookingId}`);
  }

  async getMyBookings(status?: string): Promise<Booking[]> {
    const query = status ? `?status=${status}` : '';
    return this.request(`/bookings${query}`);
  }

  async getHotelBookings(hotelId: string, status?: string, startDate?: string, endDate?: string): Promise<Booking[]> {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (startDate) query.set('startDate', startDate);
    if (endDate) query.set('endDate', endDate);
    const queryString = query.toString();
    return this.request(`/bookings/hotel/${hotelId}${queryString ? `?${queryString}` : ''}`);
  }

  async submitReview(bookingId: string, data: { rating: number; title?: string; content?: string }): Promise<Review> {
    return this.request(`/bookings/${bookingId}/review`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
}

export const api = new ApiService();
