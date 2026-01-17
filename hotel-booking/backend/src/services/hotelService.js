const db = require('../models/db');
const elasticsearch = require('../models/elasticsearch');

class HotelService {
  async createHotel(hotelData, ownerId) {
    const {
      name,
      description,
      address,
      city,
      state,
      country,
      postalCode,
      latitude,
      longitude,
      starRating,
      amenities = [],
      checkInTime = '15:00',
      checkOutTime = '11:00',
      cancellationPolicy,
      images = [],
    } = hotelData;

    const result = await db.query(
      `INSERT INTO hotels
       (owner_id, name, description, address, city, state, country, postal_code,
        latitude, longitude, star_rating, amenities, check_in_time, check_out_time,
        cancellation_policy, images)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        ownerId,
        name,
        description,
        address,
        city,
        state,
        country,
        postalCode,
        latitude,
        longitude,
        starRating,
        amenities,
        checkInTime,
        checkOutTime,
        cancellationPolicy,
        images,
      ]
    );

    const hotel = this.formatHotel(result.rows[0]);

    // Index in Elasticsearch
    await this.indexHotelInElasticsearch(hotel.id);

    return hotel;
  }

  async updateHotel(hotelId, hotelData, ownerId) {
    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM hotels WHERE id = $1 AND owner_id = $2',
      [hotelId, ownerId]
    );

    if (ownerCheck.rows.length === 0) {
      throw new Error('Hotel not found or access denied');
    }

    const {
      name,
      description,
      address,
      city,
      state,
      country,
      postalCode,
      latitude,
      longitude,
      starRating,
      amenities,
      checkInTime,
      checkOutTime,
      cancellationPolicy,
      images,
      isActive,
    } = hotelData;

    const result = await db.query(
      `UPDATE hotels SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       address = COALESCE($3, address),
       city = COALESCE($4, city),
       state = COALESCE($5, state),
       country = COALESCE($6, country),
       postal_code = COALESCE($7, postal_code),
       latitude = COALESCE($8, latitude),
       longitude = COALESCE($9, longitude),
       star_rating = COALESCE($10, star_rating),
       amenities = COALESCE($11, amenities),
       check_in_time = COALESCE($12, check_in_time),
       check_out_time = COALESCE($13, check_out_time),
       cancellation_policy = COALESCE($14, cancellation_policy),
       images = COALESCE($15, images),
       is_active = COALESCE($16, is_active)
       WHERE id = $17
       RETURNING *`,
      [
        name,
        description,
        address,
        city,
        state,
        country,
        postalCode,
        latitude,
        longitude,
        starRating,
        amenities,
        checkInTime,
        checkOutTime,
        cancellationPolicy,
        images,
        isActive,
        hotelId,
      ]
    );

    const hotel = this.formatHotel(result.rows[0]);

    // Update Elasticsearch index
    await this.indexHotelInElasticsearch(hotel.id);

    return hotel;
  }

  async getHotelById(hotelId) {
    const result = await db.query(
      `SELECT h.*,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(r.id) as review_count
       FROM hotels h
       LEFT JOIN reviews r ON h.id = r.hotel_id
       WHERE h.id = $1
       GROUP BY h.id`,
      [hotelId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const hotel = this.formatHotel(result.rows[0]);

    // Get room types
    const roomsResult = await db.query(
      'SELECT * FROM room_types WHERE hotel_id = $1 AND is_active = true ORDER BY base_price',
      [hotelId]
    );

    hotel.roomTypes = roomsResult.rows.map(this.formatRoomType);

    return hotel;
  }

  async getHotelsByOwner(ownerId) {
    const result = await db.query(
      `SELECT h.*,
              COALESCE(AVG(r.rating), 0) as avg_rating,
              COUNT(r.id) as review_count
       FROM hotels h
       LEFT JOIN reviews r ON h.id = r.hotel_id
       WHERE h.owner_id = $1
       GROUP BY h.id
       ORDER BY h.created_at DESC`,
      [ownerId]
    );

    return result.rows.map(this.formatHotel);
  }

  async deleteHotel(hotelId, ownerId) {
    const result = await db.query(
      'DELETE FROM hotels WHERE id = $1 AND owner_id = $2 RETURNING id',
      [hotelId, ownerId]
    );

    if (result.rows.length === 0) {
      throw new Error('Hotel not found or access denied');
    }

    // Remove from Elasticsearch
    await elasticsearch.removeHotel(hotelId);

    return true;
  }

  async indexHotelInElasticsearch(hotelId) {
    const hotel = await this.getHotelById(hotelId);
    if (!hotel) return;

    const doc = {
      hotel_id: hotel.id,
      name: hotel.name,
      description: hotel.description,
      city: hotel.city,
      state: hotel.state,
      country: hotel.country,
      address: hotel.address,
      location: hotel.latitude && hotel.longitude
        ? { lat: parseFloat(hotel.latitude), lon: parseFloat(hotel.longitude) }
        : null,
      star_rating: hotel.starRating,
      amenities: hotel.amenities,
      images: hotel.images,
      check_in_time: hotel.checkInTime,
      check_out_time: hotel.checkOutTime,
      is_active: hotel.isActive,
      room_types: hotel.roomTypes ? hotel.roomTypes.map(rt => ({
        id: rt.id,
        name: rt.name,
        capacity: rt.capacity,
        base_price: rt.basePrice,
        amenities: rt.amenities,
      })) : [],
      min_price: hotel.roomTypes && hotel.roomTypes.length > 0
        ? Math.min(...hotel.roomTypes.map(rt => rt.basePrice))
        : 0,
      max_capacity: hotel.roomTypes && hotel.roomTypes.length > 0
        ? Math.max(...hotel.roomTypes.map(rt => rt.capacity))
        : 0,
      avg_rating: parseFloat(hotel.avgRating) || 0,
      review_count: parseInt(hotel.reviewCount) || 0,
    };

    await elasticsearch.indexHotel(doc);
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
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new HotelService();
