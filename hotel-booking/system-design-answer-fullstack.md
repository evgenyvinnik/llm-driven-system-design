# Hotel Booking System - System Design Answer (Full-Stack Focus)

*45-minute system design interview format - Full-Stack Engineer Position*

## Opening Statement

"Today I'll design a hotel booking system like Booking.com or Expedia. As a full-stack engineer, I'll focus on the integration points between frontend and backend: the API contract for search and booking, shared TypeScript types for type safety, the booking flow with reservation holds and payment coordination, and real-time availability updates. I'll demonstrate how the React frontend and Node.js backend work together to prevent double bookings while maintaining a responsive user experience."

---

## Step 1: Requirements Clarification (3-5 minutes)

### Functional Requirements

1. **Search with real-time availability** - Frontend displays results, backend combines ES + PostgreSQL
2. **Booking with reservation holds** - 15-minute hold while user completes payment
3. **Dynamic pricing** - Base prices with date-specific overrides from admin UI
4. **Admin dashboard** - Hotel owners manage rooms and pricing via API
5. **User bookings** - View, confirm, cancel with proper state transitions

### Non-Functional Requirements

- **Consistency**: Zero double-bookings through pessimistic locking
- **Responsiveness**: Optimistic UI updates with proper error handling
- **Type Safety**: Shared types between frontend and backend
- **API Design**: RESTful with clear error responses

### Full-Stack Focus Areas

- API contract design with TypeScript interfaces
- Booking flow coordination (reserve → payment → confirm)
- Error handling across the stack
- Availability cache and real-time updates
- Admin API for hotel management

---

## Step 2: API Contract Design (8 minutes)

### Shared TypeScript Types

```typescript
// shared/types.ts - Used by both frontend and backend

// ============= Core Entities =============

export interface Hotel {
  id: string;
  name: string;
  description: string;
  address: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  starRating: number;
  amenities: string[];
  images: string[];
  status: 'active' | 'inactive' | 'pending';
  createdAt: string;
}

export interface RoomType {
  id: string;
  hotelId: string;
  name: string;
  description: string;
  basePrice: number;
  maxGuests: number;
  totalRooms: number;
  amenities: string[];
  images: string[];
}

export interface Booking {
  id: string;
  userId: string;
  hotelId: string;
  roomTypeId: string;
  checkIn: string;  // YYYY-MM-DD
  checkOut: string;
  roomCount: number;
  totalPrice: number;
  status: BookingStatus;
  guestName: string;
  guestEmail: string;
  specialRequests?: string;
  expiresAt?: string;  // For reserved bookings
  createdAt: string;
}

export type BookingStatus = 'reserved' | 'confirmed' | 'cancelled' | 'completed' | 'expired';

// ============= API Request/Response Types =============

export interface SearchParams {
  location?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  checkIn: string;
  checkOut: string;
  guests: number;
  rooms?: number;
  priceMin?: number;
  priceMax?: number;
  starRating?: number[];
  amenities?: string[];
}

export interface SearchResult {
  hotels: HotelSearchResult[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HotelSearchResult extends Hotel {
  lowestPrice: number;
  availableRoomTypes: RoomTypeAvailability[];
  rating: number;
  reviewCount: number;
}

export interface RoomTypeAvailability {
  roomType: RoomType;
  availableRooms: number;
  pricePerNight: number;
  totalPrice: number;
}

export interface CreateBookingRequest {
  hotelId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  roomCount: number;
  guestName: string;
  guestEmail: string;
  specialRequests?: string;
}

export interface CreateBookingResponse {
  booking: Booking;
  deduplicated: boolean;  // True if this was a retry that returned existing booking
  expiresIn: number;      // Seconds until reservation expires
}

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, string>;
}

// ============= Availability Types =============

export interface AvailabilityQuery {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
}

export interface AvailabilityResult {
  roomTypeId: string;
  availableRooms: number;
  prices: DailyPrice[];
  totalPrice: number;
}

export interface DailyPrice {
  date: string;
  price: number;
  isOverride: boolean;
}

// ============= Admin Types =============

export interface CreateHotelRequest {
  name: string;
  description: string;
  address: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  starRating: number;
  amenities: string[];
}

export interface CreateRoomTypeRequest {
  hotelId: string;
  name: string;
  description: string;
  basePrice: number;
  maxGuests: number;
  totalRooms: number;
  amenities: string[];
}

export interface PriceOverride {
  date: string;
  price: number;
  reason?: string;
}

export interface SetPriceOverridesRequest {
  roomTypeId: string;
  overrides: PriceOverride[];
}
```

### API Endpoints

```typescript
// API Route Definitions

// ============= Public API =============

// Search
POST /api/v1/search
  Request: SearchParams
  Response: SearchResult

// Hotels
GET  /api/v1/hotels/:hotelId
  Response: Hotel & { roomTypes: RoomType[] }

GET  /api/v1/hotels/:hotelId/availability
  Query: { checkIn, checkOut }
  Response: RoomTypeAvailability[]

// Bookings
POST /api/v1/bookings
  Request: CreateBookingRequest
  Response: CreateBookingResponse | ApiError
  Headers: X-Idempotency-Key (recommended)

GET  /api/v1/bookings
  Response: Booking[]

GET  /api/v1/bookings/:bookingId
  Response: Booking

POST /api/v1/bookings/:bookingId/confirm
  Response: Booking | ApiError

POST /api/v1/bookings/:bookingId/cancel
  Response: Booking | ApiError

// Reviews
POST /api/v1/bookings/:bookingId/review
  Request: { rating: number, title: string, content: string }
  Response: Review

// ============= Admin API =============

POST   /api/v1/admin/hotels
  Request: CreateHotelRequest
  Response: Hotel

PUT    /api/v1/admin/hotels/:hotelId
  Request: Partial<CreateHotelRequest>
  Response: Hotel

POST   /api/v1/admin/hotels/:hotelId/rooms
  Request: CreateRoomTypeRequest
  Response: RoomType

PUT    /api/v1/admin/rooms/:roomTypeId
  Request: Partial<CreateRoomTypeRequest>
  Response: RoomType

PUT    /api/v1/admin/rooms/:roomTypeId/pricing
  Request: SetPriceOverridesRequest
  Response: { updated: number }

GET    /api/v1/admin/hotels/:hotelId/bookings
  Query: { status?, page?, limit? }
  Response: { bookings: Booking[], total: number }
```

---

## Step 3: Booking Flow Integration (10 minutes)

### Frontend: Booking Hook

```typescript
// hooks/useBooking.ts
import { useState, useCallback } from 'react';
import { useBookingStore } from '@/stores/bookingStore';
import { api } from '@/services/api';
import type { CreateBookingRequest, CreateBookingResponse, ApiError } from '@/shared/types';

interface UseBookingResult {
  createReservation: (request: CreateBookingRequest) => Promise<CreateBookingResponse>;
  confirmBooking: (bookingId: string) => Promise<void>;
  cancelBooking: (bookingId: string) => Promise<void>;
  isLoading: boolean;
  error: ApiError | null;
  expiryCountdown: number | null;
}

export function useBooking(): UseBookingResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expiryCountdown, setExpiryCountdown] = useState<number | null>(null);

  const { setStep, setConfirmation, setError: setStoreError } = useBookingStore();

  const createReservation = useCallback(async (request: CreateBookingRequest) => {
    setIsLoading(true);
    setError(null);

    try {
      // Generate idempotency key for retry safety
      const idempotencyKey = generateIdempotencyKey(request);

      const response = await api.createBooking(request, idempotencyKey);

      if (!response.ok) {
        const errorData: ApiError = await response.json();

        // Handle specific error codes
        if (errorData.code === 'ROOM_UNAVAILABLE') {
          setError(errorData);
          setStoreError('This room is no longer available. Please try another.');
          throw new Error(errorData.error);
        }

        throw new Error(errorData.error);
      }

      const result: CreateBookingResponse = await response.json();

      // Start expiry countdown timer
      startExpiryCountdown(result.expiresIn);

      // Move to payment step
      setStep('payment');

      return result;
    } catch (err) {
      const apiError: ApiError = {
        error: err instanceof Error ? err.message : 'Failed to create reservation',
        code: 'UNKNOWN_ERROR',
      };
      setError(apiError);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [setStep, setStoreError]);

  const confirmBooking = useCallback(async (bookingId: string) => {
    setIsLoading(true);

    try {
      const response = await api.confirmBooking(bookingId);

      if (!response.ok) {
        const errorData: ApiError = await response.json();

        if (errorData.code === 'RESERVATION_EXPIRED') {
          setError(errorData);
          setStoreError('Your reservation has expired. Please start a new booking.');
          setStep('select');
          throw new Error(errorData.error);
        }

        throw new Error(errorData.error);
      }

      const booking = await response.json();

      // Clear countdown and move to confirmation
      setExpiryCountdown(null);
      setConfirmation(booking.id);
      setStep('confirmation');
    } catch (err) {
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [setStep, setConfirmation, setStoreError]);

  const cancelBooking = useCallback(async (bookingId: string) => {
    setIsLoading(true);

    try {
      const response = await api.cancelBooking(bookingId);

      if (!response.ok) {
        throw new Error('Failed to cancel booking');
      }

      setExpiryCountdown(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const startExpiryCountdown = (expiresIn: number) => {
    setExpiryCountdown(expiresIn);

    const interval = setInterval(() => {
      setExpiryCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  return {
    createReservation,
    confirmBooking,
    cancelBooking,
    isLoading,
    error,
    expiryCountdown,
  };
}

function generateIdempotencyKey(request: CreateBookingRequest): string {
  const data = JSON.stringify({
    hotelId: request.hotelId,
    roomTypeId: request.roomTypeId,
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    roomCount: request.roomCount,
    timestamp: Math.floor(Date.now() / 60000), // Round to minute
  });

  // Simple hash for client-side (actual security in backend)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `client-${Math.abs(hash).toString(36)}`;
}
```

### Backend: Booking Service

```typescript
// services/bookingService.ts
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import { generateIdempotencyKey } from '../shared/idempotency';
import { withLock, createRoomLockResource } from '../shared/distributedLock';
import { metrics } from '../shared/metrics';
import type { CreateBookingRequest, Booking, AvailabilityResult } from '../shared/types';

const RESERVATION_HOLD_MINUTES = 15;

export class BookingService {
  /**
   * Create a booking reservation with pessimistic locking.
   * The booking starts in 'reserved' status with a 15-minute hold.
   */
  async createBooking(
    request: CreateBookingRequest,
    userId: string
  ): Promise<{ booking: Booking; deduplicated: boolean; expiresIn: number }> {
    const startTime = Date.now();

    // Generate idempotency key from booking parameters
    const idempotencyKey = generateIdempotencyKey(userId, request);

    // Check for existing booking with same idempotency key
    const existing = await this.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      metrics.bookingsDeduplicatedTotal.inc();
      return {
        booking: existing,
        deduplicated: true,
        expiresIn: this.calculateExpiresIn(existing.expiresAt),
      };
    }

    // Create distributed lock for high-contention scenarios
    const lockResource = createRoomLockResource(
      request.hotelId,
      request.roomTypeId,
      request.checkIn,
      request.checkOut
    );

    return withLock(lockResource, async () => {
      return await this.executeBookingTransaction(request, userId, idempotencyKey, startTime);
    });
  }

  private async executeBookingTransaction(
    request: CreateBookingRequest,
    userId: string,
    idempotencyKey: string,
    startTime: number
  ): Promise<{ booking: Booking; deduplicated: boolean; expiresIn: number }> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Lock room type row for this transaction
      const roomTypeResult = await client.query(`
        SELECT id, total_rooms, base_price, hotel_id
        FROM room_types
        WHERE id = $1
        FOR UPDATE
      `, [request.roomTypeId]);

      if (roomTypeResult.rows.length === 0) {
        throw new BookingError('Room type not found', 'ROOM_NOT_FOUND');
      }

      const roomType = roomTypeResult.rows[0];

      // 2. Check availability within the lock
      const availability = await this.checkAvailabilityInTransaction(
        client,
        request.roomTypeId,
        request.checkIn,
        request.checkOut
      );

      if (availability.availableRooms < request.roomCount) {
        throw new BookingError(
          `Only ${availability.availableRooms} rooms available`,
          'ROOM_UNAVAILABLE'
        );
      }

      // 3. Calculate total price
      const totalPrice = await this.calculateTotalPrice(
        client,
        request.roomTypeId,
        request.checkIn,
        request.checkOut,
        request.roomCount
      );

      // 4. Create the reservation
      const expiresAt = new Date(Date.now() + RESERVATION_HOLD_MINUTES * 60 * 1000);

      const bookingResult = await client.query(`
        INSERT INTO bookings (
          user_id, hotel_id, room_type_id, check_in, check_out,
          room_count, total_price, status, guest_name, guest_email,
          special_requests, expires_at, idempotency_key
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', $8, $9, $10, $11, $12)
        RETURNING *
      `, [
        userId,
        request.hotelId,
        request.roomTypeId,
        request.checkIn,
        request.checkOut,
        request.roomCount,
        totalPrice,
        request.guestName,
        request.guestEmail,
        request.specialRequests || null,
        expiresAt,
        idempotencyKey,
      ]);

      await client.query('COMMIT');

      const booking = this.mapBookingRow(bookingResult.rows[0]);

      // 5. Invalidate availability cache
      await this.invalidateAvailabilityCache(
        request.hotelId,
        request.roomTypeId,
        request.checkIn,
        request.checkOut
      );

      // 6. Track metrics
      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.bookingsCreatedTotal.inc({ status: 'reserved', hotel_id: request.hotelId });
      metrics.bookingCreationDurationSeconds.observe(durationSeconds);

      return {
        booking,
        deduplicated: false,
        expiresIn: RESERVATION_HOLD_MINUTES * 60,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Confirm a reserved booking after successful payment.
   */
  async confirmBooking(bookingId: string, userId: string): Promise<Booking> {
    const result = await pool.query(`
      UPDATE bookings
      SET status = 'confirmed',
          expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND status = 'reserved'
        AND expires_at > NOW()
      RETURNING *
    `, [bookingId, userId]);

    if (result.rows.length === 0) {
      // Check if booking exists but expired
      const existing = await pool.query(
        'SELECT status, expires_at FROM bookings WHERE id = $1',
        [bookingId]
      );

      if (existing.rows.length === 0) {
        throw new BookingError('Booking not found', 'BOOKING_NOT_FOUND');
      }

      if (existing.rows[0].status === 'expired' ||
          (existing.rows[0].expires_at && new Date(existing.rows[0].expires_at) < new Date())) {
        throw new BookingError('Reservation has expired', 'RESERVATION_EXPIRED');
      }

      throw new BookingError('Booking cannot be confirmed', 'INVALID_STATUS');
    }

    const booking = this.mapBookingRow(result.rows[0]);

    // Track metrics
    metrics.bookingsConfirmedTotal.inc({ hotel_id: booking.hotelId });
    metrics.bookingRevenueTotalCents.inc(
      { hotel_id: booking.hotelId, room_type_id: booking.roomTypeId },
      booking.totalPrice * 100
    );

    return booking;
  }

  /**
   * Cancel a booking (reserved or confirmed).
   */
  async cancelBooking(bookingId: string, userId: string): Promise<Booking> {
    const result = await pool.query(`
      UPDATE bookings
      SET status = 'cancelled',
          cancelled_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND user_id = $2
        AND status IN ('reserved', 'confirmed')
      RETURNING *
    `, [bookingId, userId]);

    if (result.rows.length === 0) {
      throw new BookingError('Booking not found or cannot be cancelled', 'CANNOT_CANCEL');
    }

    const booking = this.mapBookingRow(result.rows[0]);

    // Invalidate availability cache to reflect freed inventory
    await this.invalidateAvailabilityCache(
      booking.hotelId,
      booking.roomTypeId,
      booking.checkIn,
      booking.checkOut
    );

    metrics.bookingsCancelledTotal.inc({
      hotel_id: booking.hotelId,
      reason: 'user_initiated',
    });

    return booking;
  }

  private async checkAvailabilityInTransaction(
    client: PoolClient,
    roomTypeId: string,
    checkIn: string,
    checkOut: string
  ): Promise<{ availableRooms: number }> {
    const result = await client.query(`
      SELECT rt.total_rooms - COALESCE(max_booked.count, 0) AS available_rooms
      FROM room_types rt
      LEFT JOIN (
        SELECT room_type_id, MAX(nightly_bookings) AS count
        FROM (
          SELECT
            b.room_type_id,
            d::date AS night,
            SUM(b.room_count) AS nightly_bookings
          FROM bookings b
          CROSS JOIN generate_series(
            b.check_in,
            b.check_out - INTERVAL '1 day',
            '1 day'
          ) AS d
          WHERE b.room_type_id = $1
            AND b.status IN ('reserved', 'confirmed')
            AND d::date >= $2
            AND d::date < $3
          GROUP BY b.room_type_id, d::date
        ) nightly
        GROUP BY room_type_id
      ) max_booked ON rt.id = max_booked.room_type_id
      WHERE rt.id = $1
    `, [roomTypeId, checkIn, checkOut]);

    return { availableRooms: result.rows[0]?.available_rooms ?? 0 };
  }

  private async calculateTotalPrice(
    client: PoolClient,
    roomTypeId: string,
    checkIn: string,
    checkOut: string,
    roomCount: number
  ): Promise<number> {
    // Get base price and any overrides
    const result = await client.query(`
      SELECT
        d::date AS date,
        COALESCE(po.price, rt.base_price) AS price
      FROM room_types rt
      CROSS JOIN generate_series($2::date, $3::date - INTERVAL '1 day', '1 day') AS d
      LEFT JOIN price_overrides po
        ON po.room_type_id = rt.id
        AND po.date = d::date
      WHERE rt.id = $1
    `, [roomTypeId, checkIn, checkOut]);

    const totalNightlyPrice = result.rows.reduce(
      (sum, row) => sum + parseFloat(row.price),
      0
    );

    return totalNightlyPrice * roomCount;
  }

  private async invalidateAvailabilityCache(
    hotelId: string,
    roomTypeId: string,
    checkIn: string,
    checkOut: string
  ): Promise<void> {
    const pattern = `availability:${hotelId}:${roomTypeId}:*`;
    const keys = await redis.keys(pattern);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  private calculateExpiresIn(expiresAt: string | null): number {
    if (!expiresAt) return 0;
    const expiresMs = new Date(expiresAt).getTime() - Date.now();
    return Math.max(0, Math.floor(expiresMs / 1000));
  }

  private mapBookingRow(row: any): Booking {
    return {
      id: row.id,
      userId: row.user_id,
      hotelId: row.hotel_id,
      roomTypeId: row.room_type_id,
      checkIn: row.check_in,
      checkOut: row.check_out,
      roomCount: row.room_count,
      totalPrice: parseFloat(row.total_price),
      status: row.status,
      guestName: row.guest_name,
      guestEmail: row.guest_email,
      specialRequests: row.special_requests,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
  }

  private async findByIdempotencyKey(key: string): Promise<Booking | null> {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE idempotency_key = $1',
      [key]
    );
    return result.rows.length > 0 ? this.mapBookingRow(result.rows[0]) : null;
  }
}

export class BookingError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'BookingError';
  }
}
```

---

## Step 4: Search Integration (8 minutes)

### Frontend: Search Page

```tsx
// routes/search.tsx
import { useEffect } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useSearchStore } from '@/stores/searchStore';
import { api } from '@/services/api';
import { SearchBar } from '@/components/search/SearchBar';
import { FiltersPanel } from '@/components/search/FiltersPanel';
import { HotelCard } from '@/components/hotel/HotelCard';
import type { SearchParams } from '@/shared/types';

export default function SearchPage() {
  const searchParams = useSearch({ from: '/search' });
  const {
    results,
    isLoading,
    error,
    setResults,
    setLoading,
    setError,
  } = useSearchStore();

  useEffect(() => {
    performSearch(searchParams);
  }, [searchParams]);

  const performSearch = async (params: SearchParams) => {
    setLoading(true);
    setError(null);

    try {
      const response = await api.search(params);

      if (!response.ok) {
        throw new Error('Search failed');
      }

      const data = await response.json();
      setResults(data.hotels);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Search Bar */}
      <SearchBar variant="compact" />

      <div className="mt-8 flex gap-8">
        {/* Filters Sidebar */}
        <aside className="w-64 flex-shrink-0 hidden lg:block">
          <FiltersPanel
            onFilterChange={(filters) => {
              performSearch({ ...searchParams, ...filters });
            }}
          />
        </aside>

        {/* Results */}
        <main className="flex-1">
          {/* Results Header */}
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-xl font-semibold">
              {isLoading ? 'Searching...' : `${results.length} hotels found`}
            </h1>
            <select className="border rounded-lg px-3 py-2">
              <option value="recommended">Recommended</option>
              <option value="price_low">Price: Low to High</option>
              <option value="price_high">Price: High to Low</option>
              <option value="rating">Rating</option>
            </select>
          </div>

          {/* Error State */}
          {error && (
            <div className="bg-red-50 text-red-600 p-4 rounded-lg mb-6">
              {error}
            </div>
          )}

          {/* Loading State */}
          {isLoading && (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="bg-gray-100 rounded-xl h-72 animate-pulse" />
              ))}
            </div>
          )}

          {/* Results Grid */}
          {!isLoading && results.length > 0 && (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {results.map((hotel) => (
                <HotelCard
                  key={hotel.id}
                  hotel={hotel}
                  checkIn={searchParams.checkIn}
                  checkOut={searchParams.checkOut}
                />
              ))}
            </div>
          )}

          {/* Empty State */}
          {!isLoading && results.length === 0 && !error && (
            <div className="text-center py-16">
              <h2 className="text-lg font-medium text-gray-900">No hotels found</h2>
              <p className="text-gray-500 mt-2">
                Try adjusting your search criteria or dates
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
```

### Backend: Search Service

```typescript
// services/searchService.ts
import { elasticsearch } from '../shared/elasticsearch';
import { pool } from '../shared/db';
import { redis } from '../shared/cache';
import type { SearchParams, SearchResult, HotelSearchResult } from '../shared/types';

const AVAILABILITY_CACHE_TTL = 300; // 5 minutes

export class SearchService {
  /**
   * Two-phase search: Elasticsearch for filtering, PostgreSQL for availability.
   */
  async search(params: SearchParams): Promise<SearchResult> {
    // Phase 1: Elasticsearch query
    const esQuery = this.buildElasticsearchQuery(params);
    const esResults = await elasticsearch.search({
      index: 'hotels',
      body: esQuery,
      size: 100,
    });

    const candidateHotels = esResults.hits.hits.map((hit: any) => ({
      ...hit._source,
      id: hit._id,
    }));

    if (candidateHotels.length === 0) {
      return { hotels: [], total: 0, page: 1, pageSize: 20 };
    }

    // Phase 2: Real-time availability check
    const availableHotels = await this.filterByAvailability(
      candidateHotels,
      params.checkIn,
      params.checkOut,
      params.rooms || 1
    );

    // Rank results
    const rankedHotels = this.rankHotels(availableHotels, params);

    // Apply pagination
    const page = params.page || 1;
    const pageSize = params.pageSize || 20;
    const startIndex = (page - 1) * pageSize;
    const paginatedHotels = rankedHotels.slice(startIndex, startIndex + pageSize);

    return {
      hotels: paginatedHotels,
      total: rankedHotels.length,
      page,
      pageSize,
    };
  }

  private buildElasticsearchQuery(params: SearchParams) {
    const must: any[] = [];
    const filter: any[] = [];

    // Location query
    if (params.latitude && params.longitude) {
      filter.push({
        geo_distance: {
          distance: '50km',
          location: {
            lat: params.latitude,
            lon: params.longitude,
          },
        },
      });
    } else if (params.city) {
      must.push({
        match: { city: params.city },
      });
    } else if (params.location) {
      must.push({
        multi_match: {
          query: params.location,
          fields: ['city', 'country', 'name'],
        },
      });
    }

    // Price filter
    if (params.priceMin || params.priceMax) {
      filter.push({
        range: {
          min_price: {
            ...(params.priceMin && { gte: params.priceMin }),
            ...(params.priceMax && { lte: params.priceMax }),
          },
        },
      });
    }

    // Star rating filter
    if (params.starRating && params.starRating.length > 0) {
      filter.push({
        terms: { star_rating: params.starRating },
      });
    }

    // Amenities filter
    if (params.amenities && params.amenities.length > 0) {
      filter.push({
        terms: { amenities: params.amenities },
      });
    }

    // Only active hotels
    filter.push({ term: { status: 'active' } });

    return {
      query: {
        bool: {
          must: must.length > 0 ? must : [{ match_all: {} }],
          filter,
        },
      },
    };
  }

  private async filterByAvailability(
    hotels: any[],
    checkIn: string,
    checkOut: string,
    requiredRooms: number
  ): Promise<HotelSearchResult[]> {
    const results: HotelSearchResult[] = [];

    // Check availability in parallel for all hotels
    const availabilityPromises = hotels.map(async (hotel) => {
      const roomAvailability = await this.getHotelRoomAvailability(
        hotel.id,
        checkIn,
        checkOut,
        requiredRooms
      );

      if (roomAvailability.length > 0) {
        const lowestPrice = Math.min(...roomAvailability.map(r => r.totalPrice));

        return {
          ...hotel,
          lowestPrice,
          availableRoomTypes: roomAvailability,
        };
      }

      return null;
    });

    const resolvedResults = await Promise.all(availabilityPromises);
    return resolvedResults.filter((r): r is HotelSearchResult => r !== null);
  }

  private async getHotelRoomAvailability(
    hotelId: string,
    checkIn: string,
    checkOut: string,
    requiredRooms: number
  ) {
    // Check cache first
    const cacheKey = `availability:${hotelId}:${checkIn}:${checkOut}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      const parsed = JSON.parse(cached);
      return parsed.filter((r: any) => r.availableRooms >= requiredRooms);
    }

    // Query database
    const result = await pool.query(`
      SELECT
        rt.id,
        rt.name,
        rt.base_price,
        rt.max_guests,
        rt.total_rooms,
        rt.amenities,
        rt.images,
        rt.total_rooms - COALESCE(booked.max_rooms, 0) AS available_rooms
      FROM room_types rt
      LEFT JOIN (
        SELECT room_type_id, MAX(nightly_count) AS max_rooms
        FROM (
          SELECT
            b.room_type_id,
            d::date,
            SUM(b.room_count) AS nightly_count
          FROM bookings b
          CROSS JOIN generate_series(b.check_in, b.check_out - INTERVAL '1 day', '1 day') AS d
          WHERE b.hotel_id = $1
            AND b.status IN ('reserved', 'confirmed')
            AND d::date >= $2 AND d::date < $3
          GROUP BY b.room_type_id, d::date
        ) nights
        GROUP BY room_type_id
      ) booked ON rt.id = booked.room_type_id
      WHERE rt.hotel_id = $1
    `, [hotelId, checkIn, checkOut]);

    // Calculate prices for available rooms
    const roomAvailability = await Promise.all(
      result.rows
        .filter(row => row.available_rooms > 0)
        .map(async (row) => {
          const pricing = await this.calculateRoomPricing(row.id, checkIn, checkOut);
          return {
            roomType: {
              id: row.id,
              hotelId,
              name: row.name,
              basePrice: parseFloat(row.base_price),
              maxGuests: row.max_guests,
              totalRooms: row.total_rooms,
              amenities: row.amenities || [],
              images: row.images || [],
            },
            availableRooms: row.available_rooms,
            pricePerNight: pricing.avgPricePerNight,
            totalPrice: pricing.totalPrice,
          };
        })
    );

    // Cache the result
    await redis.setex(cacheKey, AVAILABILITY_CACHE_TTL, JSON.stringify(roomAvailability));

    return roomAvailability.filter(r => r.availableRooms >= requiredRooms);
  }

  private async calculateRoomPricing(roomTypeId: string, checkIn: string, checkOut: string) {
    const result = await pool.query(`
      SELECT
        d::date AS date,
        COALESCE(po.price, rt.base_price) AS price
      FROM room_types rt
      CROSS JOIN generate_series($2::date, $3::date - INTERVAL '1 day', '1 day') AS d
      LEFT JOIN price_overrides po
        ON po.room_type_id = rt.id AND po.date = d::date
      WHERE rt.id = $1
    `, [roomTypeId, checkIn, checkOut]);

    const prices = result.rows.map(r => parseFloat(r.price));
    const totalPrice = prices.reduce((sum, p) => sum + p, 0);
    const avgPricePerNight = totalPrice / prices.length;

    return { totalPrice, avgPricePerNight };
  }

  private rankHotels(hotels: HotelSearchResult[], params: SearchParams): HotelSearchResult[] {
    return hotels.sort((a, b) => {
      const scoreA = this.calculateRankingScore(a);
      const scoreB = this.calculateRankingScore(b);
      return scoreB - scoreA;
    });
  }

  private calculateRankingScore(hotel: HotelSearchResult): number {
    return (
      0.3 * (hotel.rating / 5) +
      0.2 * (hotel.reviewCount / 1000) +
      0.3 * (1 - hotel.lowestPrice / 500) +
      0.2 * (hotel.starRating / 5)
    );
  }
}
```

---

## Step 5: Real-Time Availability Updates (5 minutes)

### Frontend: Availability Hook with Polling

```typescript
// hooks/useAvailability.ts
import { useState, useEffect, useCallback } from 'react';
import { api } from '@/services/api';
import type { RoomTypeAvailability } from '@/shared/types';

interface UseAvailabilityOptions {
  hotelId: string;
  checkIn: string;
  checkOut: string;
  pollInterval?: number; // milliseconds
}

export function useAvailability({
  hotelId,
  checkIn,
  checkOut,
  pollInterval = 60000, // 1 minute
}: UseAvailabilityOptions) {
  const [availability, setAvailability] = useState<RoomTypeAvailability[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchAvailability = useCallback(async () => {
    try {
      const response = await api.getHotelAvailability(hotelId, checkIn, checkOut);

      if (!response.ok) {
        throw new Error('Failed to fetch availability');
      }

      const data = await response.json();

      // Check if availability changed
      const hasChanged = JSON.stringify(data) !== JSON.stringify(availability);

      if (hasChanged) {
        setAvailability(data);
        setLastUpdated(new Date());
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load availability');
    } finally {
      setIsLoading(false);
    }
  }, [hotelId, checkIn, checkOut, availability]);

  // Initial fetch
  useEffect(() => {
    fetchAvailability();
  }, [hotelId, checkIn, checkOut]);

  // Polling
  useEffect(() => {
    if (pollInterval <= 0) return;

    const interval = setInterval(fetchAvailability, pollInterval);
    return () => clearInterval(interval);
  }, [fetchAvailability, pollInterval]);

  // Manual refresh
  const refresh = useCallback(() => {
    setIsLoading(true);
    fetchAvailability();
  }, [fetchAvailability]);

  return {
    availability,
    isLoading,
    error,
    lastUpdated,
    refresh,
  };
}
```

### Backend: Availability Endpoint with Cache

```typescript
// routes/hotels.ts
import { Router } from 'express';
import { redis } from '../shared/cache';
import { pool } from '../shared/db';

const router = Router();

router.get('/:hotelId/availability', async (req, res) => {
  const { hotelId } = req.params;
  const { checkIn, checkOut } = req.query;

  if (!checkIn || !checkOut) {
    return res.status(400).json({ error: 'checkIn and checkOut required' });
  }

  // Check cache
  const cacheKey = `availability:${hotelId}:${checkIn}:${checkOut}`;
  const cached = await redis.get(cacheKey);

  if (cached) {
    // Add cache header for client-side caching
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=60'); // 1 minute
    return res.json(JSON.parse(cached));
  }

  // Fetch from database
  const availability = await getHotelAvailability(hotelId, checkIn as string, checkOut as string);

  // Cache result
  await redis.setex(cacheKey, 300, JSON.stringify(availability));

  res.set('X-Cache', 'MISS');
  res.set('Cache-Control', 'public, max-age=60');
  res.json(availability);
});

export default router;
```

---

## Step 6: Error Handling Across the Stack (4 minutes)

### Frontend: API Service with Error Handling

```typescript
// services/api.ts
import type { ApiError } from '@/shared/types';

const API_BASE = '/api/v1';

class ApiService {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = `${API_BASE}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      credentials: 'include', // For session cookies
    });

    return response;
  }

  async createBooking(data: CreateBookingRequest, idempotencyKey: string) {
    return this.request('/bookings', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: {
        'X-Idempotency-Key': idempotencyKey,
      },
    });
  }

  async confirmBooking(bookingId: string) {
    return this.request(`/bookings/${bookingId}/confirm`, {
      method: 'POST',
    });
  }

  async cancelBooking(bookingId: string) {
    return this.request(`/bookings/${bookingId}/cancel`, {
      method: 'POST',
    });
  }

  async search(params: SearchParams) {
    return this.request('/search', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getHotelAvailability(hotelId: string, checkIn: string, checkOut: string) {
    const query = new URLSearchParams({ checkIn, checkOut });
    return this.request(`/hotels/${hotelId}/availability?${query}`);
  }
}

export const api = new ApiService();
```

### Backend: Error Handler Middleware

```typescript
// middleware/errorHandler.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../shared/logger';
import { BookingError } from '../services/bookingService';

interface ErrorResponse {
  error: string;
  code: string;
  details?: Record<string, string>;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Log the error
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    traceId: req.traceId,
  });

  // Handle known error types
  if (err instanceof BookingError) {
    const statusMap: Record<string, number> = {
      ROOM_NOT_FOUND: 404,
      ROOM_UNAVAILABLE: 409,
      BOOKING_NOT_FOUND: 404,
      RESERVATION_EXPIRED: 410,
      INVALID_STATUS: 400,
      CANNOT_CANCEL: 400,
    };

    const status = statusMap[err.code] || 400;

    return res.status(status).json({
      error: err.message,
      code: err.code,
    } as ErrorResponse);
  }

  // Handle validation errors (from Zod or similar)
  if (err.name === 'ZodError') {
    return res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: (err as any).errors,
    } as ErrorResponse);
  }

  // Generic error
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  } as ErrorResponse);
}
```

---

## Step 7: Trade-offs Discussion (3 minutes)

### Full-Stack Trade-offs Table

| Decision | Approach | Trade-off | Rationale |
|----------|----------|-----------|-----------|
| Shared types | TypeScript interfaces | Build complexity vs. type safety | Single source of truth for API contract |
| Idempotency | Client-generated key + server validation | Extra header vs. safe retries | Prevents duplicate bookings on network issues |
| Reservation hold | 15-minute expiry | Blocked inventory vs. conversion | Standard checkout timeout, background cleanup |
| Availability cache | 5-min TTL + invalidation | Stale data vs. performance | Search tolerates staleness; booking always fresh |
| Polling vs WebSocket | Polling every 60s | Latency vs. complexity | Simpler to implement; WebSocket for future |
| Error codes | Typed error codes | More code vs. better UX | Frontend can show specific error messages |

### Integration Considerations

1. **API Versioning**: Use `/api/v1/` prefix for backward compatibility
2. **CORS**: Configure for frontend domain in production
3. **Rate Limiting**: Different limits for search (high) vs. booking (low)
4. **Session Management**: HttpOnly cookies for security

---

## Closing Summary

"I've designed a full-stack hotel booking system with:

1. **Shared TypeScript types** ensuring type safety across frontend and backend
2. **Booking flow integration** with reservation holds, idempotency, and expiry countdown
3. **Two-phase search** combining Elasticsearch speed with PostgreSQL availability accuracy
4. **Real-time availability** via polling with cache headers for efficiency
5. **Error handling** with typed error codes for specific frontend responses

The key insight is maintaining strong consistency for bookings while allowing eventual consistency for search, with the API contract clearly defining the boundary between these two models. Happy to dive deeper into any aspect of the integration."

---

## Potential Follow-up Questions

1. **How would you migrate to WebSocket for real-time updates?**
   - Add Socket.io for availability change notifications
   - Backend publishes events when bookings change
   - Frontend subscribes to hotel-specific rooms

2. **How would you handle offline booking attempts?**
   - Queue booking request in IndexedDB
   - Show "pending" state with sync indicator
   - Retry when connection restored with idempotency key

3. **How would you test the full booking flow?**
   - Unit tests for booking service with mocked DB
   - Integration tests with test database
   - E2E tests with Playwright for full flow
