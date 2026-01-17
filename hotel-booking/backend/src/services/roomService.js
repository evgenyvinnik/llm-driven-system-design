const db = require('../models/db');
const hotelService = require('./hotelService');

class RoomService {
  async createRoomType(hotelId, roomData, ownerId) {
    // Verify hotel ownership
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
      capacity,
      bedType,
      totalCount,
      basePrice,
      amenities = [],
      images = [],
      sizeSqm,
    } = roomData;

    const result = await db.query(
      `INSERT INTO room_types
       (hotel_id, name, description, capacity, bed_type, total_count, base_price, amenities, images, size_sqm)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [hotelId, name, description, capacity, bedType, totalCount, basePrice, amenities, images, sizeSqm]
    );

    const roomType = this.formatRoomType(result.rows[0]);

    // Update hotel in Elasticsearch to include new room type
    await hotelService.indexHotelInElasticsearch(hotelId);

    return roomType;
  }

  async updateRoomType(roomTypeId, roomData, ownerId) {
    // Verify ownership through hotel
    const ownerCheck = await db.query(
      `SELECT rt.id FROM room_types rt
       JOIN hotels h ON rt.hotel_id = h.id
       WHERE rt.id = $1 AND h.owner_id = $2`,
      [roomTypeId, ownerId]
    );

    if (ownerCheck.rows.length === 0) {
      throw new Error('Room type not found or access denied');
    }

    const {
      name,
      description,
      capacity,
      bedType,
      totalCount,
      basePrice,
      amenities,
      images,
      sizeSqm,
      isActive,
    } = roomData;

    const result = await db.query(
      `UPDATE room_types SET
       name = COALESCE($1, name),
       description = COALESCE($2, description),
       capacity = COALESCE($3, capacity),
       bed_type = COALESCE($4, bed_type),
       total_count = COALESCE($5, total_count),
       base_price = COALESCE($6, base_price),
       amenities = COALESCE($7, amenities),
       images = COALESCE($8, images),
       size_sqm = COALESCE($9, size_sqm),
       is_active = COALESCE($10, is_active)
       WHERE id = $11
       RETURNING *`,
      [name, description, capacity, bedType, totalCount, basePrice, amenities, images, sizeSqm, isActive, roomTypeId]
    );

    const roomType = this.formatRoomType(result.rows[0]);

    // Update hotel in Elasticsearch
    await hotelService.indexHotelInElasticsearch(roomType.hotelId);

    return roomType;
  }

  async getRoomTypeById(roomTypeId) {
    const result = await db.query(
      'SELECT * FROM room_types WHERE id = $1',
      [roomTypeId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.formatRoomType(result.rows[0]);
  }

  async getRoomTypesByHotel(hotelId) {
    const result = await db.query(
      'SELECT * FROM room_types WHERE hotel_id = $1 AND is_active = true ORDER BY base_price',
      [hotelId]
    );

    return result.rows.map(this.formatRoomType);
  }

  async deleteRoomType(roomTypeId, ownerId) {
    // Get hotel ID first
    const roomResult = await db.query(
      `SELECT rt.hotel_id FROM room_types rt
       JOIN hotels h ON rt.hotel_id = h.id
       WHERE rt.id = $1 AND h.owner_id = $2`,
      [roomTypeId, ownerId]
    );

    if (roomResult.rows.length === 0) {
      throw new Error('Room type not found or access denied');
    }

    const hotelId = roomResult.rows[0].hotel_id;

    await db.query('DELETE FROM room_types WHERE id = $1', [roomTypeId]);

    // Update hotel in Elasticsearch
    await hotelService.indexHotelInElasticsearch(hotelId);

    return true;
  }

  // Set price override for a specific date
  async setPriceOverride(roomTypeId, date, price, ownerId) {
    // Verify ownership
    const ownerCheck = await db.query(
      `SELECT rt.id FROM room_types rt
       JOIN hotels h ON rt.hotel_id = h.id
       WHERE rt.id = $1 AND h.owner_id = $2`,
      [roomTypeId, ownerId]
    );

    if (ownerCheck.rows.length === 0) {
      throw new Error('Room type not found or access denied');
    }

    const result = await db.query(
      `INSERT INTO pricing_overrides (room_type_id, date, price)
       VALUES ($1, $2, $3)
       ON CONFLICT (room_type_id, date)
       DO UPDATE SET price = $3
       RETURNING *`,
      [roomTypeId, date, price]
    );

    return {
      id: result.rows[0].id,
      roomTypeId: result.rows[0].room_type_id,
      date: result.rows[0].date,
      price: parseFloat(result.rows[0].price),
    };
  }

  // Get price for a room type on a specific date (with override if exists)
  async getPrice(roomTypeId, date) {
    // Check for price override
    const overrideResult = await db.query(
      'SELECT price FROM pricing_overrides WHERE room_type_id = $1 AND date = $2',
      [roomTypeId, date]
    );

    if (overrideResult.rows.length > 0) {
      return parseFloat(overrideResult.rows[0].price);
    }

    // Fall back to base price
    const roomResult = await db.query(
      'SELECT base_price FROM room_types WHERE id = $1',
      [roomTypeId]
    );

    if (roomResult.rows.length === 0) {
      throw new Error('Room type not found');
    }

    return parseFloat(roomResult.rows[0].base_price);
  }

  // Get prices for a date range
  async getPricesForRange(roomTypeId, checkIn, checkOut) {
    const roomResult = await db.query(
      'SELECT base_price FROM room_types WHERE id = $1',
      [roomTypeId]
    );

    if (roomResult.rows.length === 0) {
      throw new Error('Room type not found');
    }

    const basePrice = parseFloat(roomResult.rows[0].base_price);

    const overridesResult = await db.query(
      'SELECT date, price FROM pricing_overrides WHERE room_type_id = $1 AND date >= $2 AND date < $3',
      [roomTypeId, checkIn, checkOut]
    );

    const overrides = {};
    overridesResult.rows.forEach((row) => {
      overrides[row.date.toISOString().split('T')[0]] = parseFloat(row.price);
    });

    const prices = [];
    const start = new Date(checkIn);
    const end = new Date(checkOut);

    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      prices.push({
        date: dateStr,
        price: overrides[dateStr] || basePrice,
      });
    }

    return {
      basePrice,
      prices,
      totalPrice: prices.reduce((sum, p) => sum + p.price, 0),
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

module.exports = new RoomService();
