/**
 * Search Service
 *
 * Handles hotel search with:
 * - Elasticsearch for fast text/geo queries
 * - PostgreSQL for accurate availability
 * - Metrics for monitoring search performance
 */

const elasticsearch = require('../models/elasticsearch');
const bookingService = require('./bookingService');
const db = require('../models/db');

// Import shared modules
const { logger, metrics } = require('../shared');

class SearchService {
  async searchHotels(params) {
    const startTime = Date.now();
    const { checkIn, checkOut, guests, rooms = 1, ...esParams } = params;

    // Track search request
    metrics.searchRequestsTotal.inc({
      has_dates: checkIn && checkOut ? 'true' : 'false',
      city: esParams.city || 'unknown',
    });

    // First, get matching hotels from Elasticsearch
    const esResult = await elasticsearch.searchHotels({
      ...esParams,
      guests,
    });

    if (!checkIn || !checkOut) {
      // No dates specified, return ES results as-is
      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.searchDurationSeconds.observe(durationSeconds);
      metrics.searchResultsCount.observe(esResult.hotels.length);

      return esResult;
    }

    // Filter by availability
    const hotelsWithAvailability = await Promise.all(
      esResult.hotels.map(async (hotel) => {
        try {
          // Get room types that can accommodate the guests
          const roomTypesResult = await db.query(
            `SELECT id, capacity, base_price FROM room_types
             WHERE hotel_id = $1 AND is_active = true AND capacity >= $2
             ORDER BY base_price`,
            [hotel.hotel_id, guests || 1]
          );

          const availableRoomTypes = [];

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

    const filteredHotels = hotelsWithAvailability.filter((h) => h !== null);

    // Record metrics
    const durationSeconds = (Date.now() - startTime) / 1000;
    metrics.searchDurationSeconds.observe(durationSeconds);
    metrics.searchResultsCount.observe(filteredHotels.length);

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

  async getHotelWithAvailability(hotelId, checkIn, checkOut, guests = 2) {
    const hotelResult = await db.query(
      `SELECT h.*,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(r.id) as review_count
       FROM hotels h
       LEFT JOIN reviews r ON h.id = r.hotel_id
       WHERE h.id = $1
       GROUP BY h.id`,
      [hotelId]
    );

    if (hotelResult.rows.length === 0) {
      return null;
    }

    const hotel = this.formatHotel(hotelResult.rows[0]);

    // Get room types with availability
    const roomTypesResult = await db.query(
      'SELECT * FROM room_types WHERE hotel_id = $1 AND is_active = true ORDER BY base_price',
      [hotelId]
    );

    const roomTypesWithAvailability = await Promise.all(
      roomTypesResult.rows.map(async (rt) => {
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
          const pricingResult = await db.query(
            'SELECT date, price FROM pricing_overrides WHERE room_type_id = $1 AND date >= $2 AND date < $3',
            [rt.id, checkIn, checkOut]
          );

          const priceOverrides = {};
          pricingResult.rows.forEach((row) => {
            priceOverrides[row.date.toISOString().split('T')[0]] = parseFloat(row.price);
          });

          // Calculate total price for the stay
          let totalPrice = 0;
          const start = new Date(checkIn);
          const end = new Date(checkOut);
          const nights = Math.ceil((end - start) / (1000 * 60 * 60 * 24));

          for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            totalPrice += priceOverrides[dateStr] || roomType.basePrice;
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

  formatHotel(row) {
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
      reviewCount: row.review_count ? parseInt(row.review_count) : 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  formatRoomType(row) {
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

module.exports = new SearchService();
