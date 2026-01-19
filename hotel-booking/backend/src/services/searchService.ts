/**
 * Search Service
 *
 * Handles hotel search with:
 * - Elasticsearch for fast text/geo queries
 * - PostgreSQL for accurate availability
 * - Metrics for monitoring search performance
 */

import { searchHotels as esSearchHotels, SearchHotelsParams, HotelDocument } from '../models/elasticsearch.js';
import bookingService, { AvailabilityCheck } from './bookingService.js';
import { query } from '../models/db.js';

// Import shared modules
import { logger, searchRequestsTotal, searchDurationSeconds, searchResultsCount } from '../shared/index.js';

export interface SearchParams extends SearchHotelsParams {
  checkIn?: string;
  checkOut?: string;
  guests?: number;
  rooms?: number;
}

export interface AvailableRoomType {
  id: string;
  capacity: number;
  basePrice: number;
  availableRooms: number;
}

export interface HotelWithAvailability extends HotelDocument {
  _score: number | null;
  availableRoomTypes?: AvailableRoomType[];
  startingPrice?: number;
}

export interface SearchResult {
  hotels: HotelWithAvailability[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface RoomTypeFormatted {
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
  sizeSqm: number | null;
  isActive: boolean;
}

export interface RoomTypeWithAvailability extends RoomTypeFormatted {
  availability?: AvailabilityCheck;
  totalPrice?: number;
  nights?: number;
  pricePerNight?: number;
}

export interface HotelFormatted {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postalCode: string;
  latitude: string | null;
  longitude: string | null;
  starRating: number;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  cancellationPolicy: string;
  images: string[];
  isActive: boolean;
  avgRating: number;
  reviewCount: number;
  createdAt: Date;
  updatedAt: Date;
  roomTypes?: RoomTypeWithAvailability[];
}

interface HotelRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  country: string;
  postal_code: string;
  latitude: string | null;
  longitude: string | null;
  star_rating: number;
  amenities: string[] | null;
  check_in_time: string;
  check_out_time: string;
  cancellation_policy: string;
  images: string[] | null;
  is_active: boolean;
  avg_rating?: string | null;
  review_count?: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RoomTypeRow {
  id: string;
  hotel_id: string;
  name: string;
  description: string;
  capacity: number;
  bed_type: string;
  total_count: number;
  base_price: string;
  amenities: string[] | null;
  images: string[] | null;
  size_sqm: number | null;
  is_active: boolean;
}

interface PriceOverrideRow {
  date: Date;
  price: string;
}

class SearchService {
  async searchHotels(params: SearchParams): Promise<SearchResult> {
    const startTime = Date.now();
    const { checkIn, checkOut, guests, rooms = 1, ...esParams } = params;

    // Track search request
    searchRequestsTotal.inc({
      has_dates: checkIn && checkOut ? 'true' : 'false',
      city: esParams.city || 'unknown',
    });

    // First, get matching hotels from Elasticsearch
    const esResult = await esSearchHotels({
      ...esParams,
      guests,
    });

    if (!checkIn || !checkOut) {
      // No dates specified, return ES results as-is
      const durationSeconds = (Date.now() - startTime) / 1000;
      searchDurationSeconds.observe(durationSeconds);
      searchResultsCount.observe(esResult.hotels.length);

      return esResult as SearchResult;
    }

    // Filter by availability
    const hotelsWithAvailability = await Promise.all(
      esResult.hotels.map(async (hotel): Promise<HotelWithAvailability | null> => {
        try {
          // Get room types that can accommodate the guests
          const roomTypesResult = await query<{ id: string; capacity: number; base_price: string }>(
            `SELECT id, capacity, base_price FROM room_types
             WHERE hotel_id = $1 AND is_active = true AND capacity >= $2
             ORDER BY base_price`,
            [hotel.hotel_id, guests || 1]
          );

          const availableRoomTypes: AvailableRoomType[] = [];

          for (const rt of roomTypesResult.rows) {
            const availability = await bookingService.checkAvailability(
              hotel.hotel_id,
              rt.id,
              checkIn,
              checkOut,
              rooms
            );

            if (availability.available) {
              availableRoomTypes.push({
                id: rt.id,
                capacity: rt.capacity,
                basePrice: parseFloat(rt.base_price),
                availableRooms: availability.availableRooms,
              });
            }
          }

          if (availableRoomTypes.length > 0) {
            return {
              ...hotel,
              availableRoomTypes,
              startingPrice: Math.min(...availableRoomTypes.map((rt) => rt.basePrice)),
            };
          }
          return null;
        } catch (error) {
          logger.error(
            { error, hotelId: hotel.hotel_id },
            'Error checking availability for hotel'
          );
          return null;
        }
      })
    );

    const filteredHotels = hotelsWithAvailability.filter((h): h is HotelWithAvailability => h !== null);

    // Record metrics
    const durationSeconds = (Date.now() - startTime) / 1000;
    searchDurationSeconds.observe(durationSeconds);
    searchResultsCount.observe(filteredHotels.length);

    logger.debug(
      {
        city: esParams.city,
        checkIn,
        checkOut,
        resultsCount: filteredHotels.length,
        durationSeconds,
      },
      'Search completed'
    );

    return {
      ...esResult,
      hotels: filteredHotels,
      total: filteredHotels.length,
    };
  }

  async getHotelWithAvailability(
    hotelId: string,
    checkIn: string | null,
    checkOut: string | null,
    guests: number = 2
  ): Promise<HotelFormatted | null> {
    const hotelResult = await query<HotelRow>(
      `SELECT h.*,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(r.id) as review_count
       FROM hotels h
       LEFT JOIN reviews r ON h.id = r.hotel_id
       WHERE h.id = $1
       GROUP BY h.id`,
      [hotelId]
    );

    if (hotelResult.rows.length === 0 || !hotelResult.rows[0]) {
      return null;
    }

    const hotel = this.formatHotel(hotelResult.rows[0]);

    // Get room types with availability
    const roomTypesResult = await query<RoomTypeRow>(
      'SELECT * FROM room_types WHERE hotel_id = $1 AND is_active = true ORDER BY base_price',
      [hotelId]
    );

    const roomTypesWithAvailability = await Promise.all(
      roomTypesResult.rows.map(async (rt): Promise<RoomTypeWithAvailability> => {
        const roomType = this.formatRoomType(rt);

        if (checkIn && checkOut) {
          const availability = await bookingService.checkAvailability(
            hotelId,
            rt.id,
            checkIn,
            checkOut,
            1
          );

          // Get pricing for the date range
          const pricingResult = await query<PriceOverrideRow>(
            'SELECT date, price FROM pricing_overrides WHERE room_type_id = $1 AND date >= $2 AND date < $3',
            [rt.id, checkIn, checkOut]
          );

          const priceOverrides: Record<string, number> = {};
          pricingResult.rows.forEach((row) => {
            const dateStr = row.date.toISOString().split('T')[0];
            if (dateStr) {
              priceOverrides[dateStr] = parseFloat(row.price);
            }
          });

          // Calculate total price for the stay
          let totalPrice = 0;
          const start = new Date(checkIn);
          const end = new Date(checkOut);
          const nights = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));

          for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0] ?? '';
            totalPrice += priceOverrides[dateStr] ?? roomType.basePrice;
          }

          return {
            ...roomType,
            availability,
            totalPrice,
            nights,
            pricePerNight: totalPrice / nights,
          };
        }

        return roomType;
      })
    );

    hotel.roomTypes = roomTypesWithAvailability;

    return hotel;
  }

  formatHotel(row: HotelRow): HotelFormatted {
    return {
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      description: row.description,
      address: row.address,
      city: row.city,
      state: row.state,
      country: row.country,
      postalCode: row.postal_code,
      latitude: row.latitude,
      longitude: row.longitude,
      starRating: row.star_rating,
      amenities: row.amenities || [],
      checkInTime: row.check_in_time,
      checkOutTime: row.check_out_time,
      cancellationPolicy: row.cancellation_policy,
      images: row.images || [],
      isActive: row.is_active,
      avgRating: row.avg_rating ? parseFloat(row.avg_rating) : 0,
      reviewCount: row.review_count ? parseInt(row.review_count, 10) : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  formatRoomType(row: RoomTypeRow): RoomTypeFormatted {
    return {
      id: row.id,
      hotelId: row.hotel_id,
      name: row.name,
      description: row.description,
      capacity: row.capacity,
      bedType: row.bed_type,
      totalCount: row.total_count,
      basePrice: parseFloat(row.base_price),
      amenities: row.amenities || [],
      images: row.images || [],
      sizeSqm: row.size_sqm,
      isActive: row.is_active,
    };
  }
}

export default new SearchService();
