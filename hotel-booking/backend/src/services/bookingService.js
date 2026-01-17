/**
 * Booking Service
 *
 * Handles all booking operations with:
 * - Idempotency to prevent double-booking
 * - Distributed locking for room selection
 * - Pessimistic database locking
 * - Metrics for monitoring and alerting
 * - Structured logging for debugging
 */

const db = require('../models/db');
const redis = require('../models/redis');
const roomService = require('./roomService');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Import shared modules
const {
  logger,
  metrics,
  generateIdempotencyKey,
  checkIdempotency,
  cacheIdempotencyResult,
  withLock,
  createRoomLockResource,
} = require('../shared');

const AVAILABILITY_CACHE_TTL = 300; // 5 minutes

class BookingService {
  /**
   * Check availability for a room type on a date range
   *
   * WHY caching reduces database load:
   * - Search pages trigger many availability checks per page load
   * - Availability changes infrequently (only on booking/cancellation)
   * - 5-minute cache reduces DB queries by ~90% during peak hours
   * - Cache is invalidated on booking state changes for consistency
   */
  async checkAvailability(hotelId, roomTypeId, checkIn, checkOut, roomCount = 1) {
    const startTime = Date.now();

    // Try cache first for calendar-style queries
    const cacheKey = `availability:check:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      metrics.availabilityCacheHitsTotal.inc();
      metrics.availabilityChecksTotal.inc({ cache_hit: 'true' });
      logger.debug({ hotelId, roomTypeId, cacheHit: true }, 'Availability cache hit');
      return JSON.parse(cached);
    }

    metrics.availabilityCacheMissesTotal.inc();
    metrics.availabilityChecksTotal.inc({ cache_hit: 'false' });

    // Get total rooms
    const roomResult = await db.query(
      'SELECT total_count FROM room_types WHERE id = $1 AND hotel_id = $2 AND is_active = true',
      [roomTypeId, hotelId]
    );

    if (roomResult.rows.length === 0) {
      throw new Error('Room type not found');
    }

    const totalRooms = roomResult.rows[0].total_count;

    // Count rooms booked for the date range
    // A booking overlaps if: booking.check_in < requested.check_out AND booking.check_out > requested.check_in
    const bookedResult = await db.query(
      `SELECT COALESCE(MAX(daily_booked), 0) as max_booked
       FROM (
         SELECT d::date as date, COALESCE(SUM(b.room_count), 0) as daily_booked
         FROM generate_series($3::date, $4::date - 1, '1 day') d
         LEFT JOIN bookings b ON b.hotel_id = $1
           AND b.room_type_id = $2
           AND b.status IN ('reserved', 'confirmed')
           AND b.check_in <= d::date
           AND b.check_out > d::date
         GROUP BY d::date
       ) daily`,
      [hotelId, roomTypeId, checkIn, checkOut]
    );

    const maxBooked = parseInt(bookedResult.rows[0].max_booked);
    const availableRooms = totalRooms - maxBooked;

    const availability = {
      available: availableRooms >= roomCount,
      availableRooms,
      totalRooms,
      requestedRooms: roomCount,
    };

    // Cache the result (short TTL for frequently changing data)
    await redis.setex(cacheKey, AVAILABILITY_CACHE_TTL, JSON.stringify(availability));

    const durationMs = Date.now() - startTime;
    logger.debug(
      { hotelId, roomTypeId, checkIn, checkOut, availableRooms, durationMs },
      'Availability check completed'
    );

    return availability;
  }

  /**
   * Get availability calendar for a month
   * Cached aggressively as calendar data changes less frequently
   */
  async getAvailabilityCalendar(hotelId, roomTypeId, year, month) {
    const cacheKey = `availability:${hotelId}:${roomTypeId}:${year}-${month}`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      metrics.availabilityCacheHitsTotal.inc();
      return JSON.parse(cached);
    }

    metrics.availabilityCacheMissesTotal.inc();

    // Get total rooms
    const roomResult = await db.query(
      'SELECT total_count, base_price FROM room_types WHERE id = $1 AND hotel_id = $2',
      [roomTypeId, hotelId]
    );

    if (roomResult.rows.length === 0) {
      throw new Error('Room type not found');
    }

    const totalRooms = roomResult.rows[0].total_count;
    const basePrice = parseFloat(roomResult.rows[0].base_price);

    // Calculate start and end of month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const endDateStr = endDate.toISOString().split('T')[0];
    const startDateStr = startDate.toISOString().split('T')[0];

    // Get bookings for the month
    const bookingsResult = await db.query(
      `SELECT check_in, check_out, room_count
       FROM bookings
       WHERE hotel_id = $1
         AND room_type_id = $2
         AND status IN ('reserved', 'confirmed')
         AND check_in <= $3
         AND check_out > $4`,
      [hotelId, roomTypeId, endDateStr, startDateStr]
    );

    // Get price overrides
    const overridesResult = await db.query(
      'SELECT date, price FROM pricing_overrides WHERE room_type_id = $1 AND date >= $2 AND date <= $3',
      [roomTypeId, startDateStr, endDateStr]
    );

    const priceOverrides = {};
    overridesResult.rows.forEach((row) => {
      priceOverrides[row.date.toISOString().split('T')[0]] = parseFloat(row.price);
    });

    // Build calendar
    const calendar = [];
    for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];

      // Count booked rooms for this date
      let bookedRooms = 0;
      for (const booking of bookingsResult.rows) {
        const checkIn = new Date(booking.check_in);
        const checkOut = new Date(booking.check_out);
        if (d >= checkIn && d < checkOut) {
          bookedRooms += booking.room_count;
        }
      }

      calendar.push({
        date: dateStr,
        available: totalRooms - bookedRooms,
        total: totalRooms,
        booked: bookedRooms,
        price: priceOverrides[dateStr] || basePrice,
      });
    }

    // Cache for 5 minutes
    await redis.setex(cacheKey, AVAILABILITY_CACHE_TTL, JSON.stringify(calendar));

    return calendar;
  }

  /**
   * Create a booking with idempotency and distributed locking
   *
   * WHY idempotency prevents double-charging:
   * - Network failures cause client retries
   * - Users may double-click submit buttons
   * - Without idempotency, retries create duplicate bookings
   * - Guest gets charged multiple times for same stay
   *
   * WHY distributed locking prevents overselling:
   * - Multiple API servers process booking requests simultaneously
   * - Pessimistic DB locks only work within single transaction
   * - Without distributed lock, concurrent requests see same availability
   * - Both could succeed, resulting in oversold room
   */
  async createBooking(bookingData, userId) {
    const startTime = Date.now();
    const {
      hotelId,
      roomTypeId,
      checkIn,
      checkOut,
      roomCount = 1,
      guestCount,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestPhone,
      specialRequests,
    } = bookingData;

    // Generate idempotency key from booking parameters
    const idempotencyKey = generateIdempotencyKey(userId, {
      hotelId,
      roomTypeId,
      checkIn,
      checkOut,
      roomCount,
    });

    // Check for existing booking with same idempotency key
    const existing = await checkIdempotency(idempotencyKey);
    if (existing) {
      logger.info(
        { idempotencyKey, bookingId: existing.id },
        'Returning existing booking (idempotent request)'
      );
      metrics.idempotentRequestsTotal.inc({ deduplicated: 'true' });
      return {
        ...this.formatBooking(existing),
        deduplicated: true,
      };
    }

    // Create distributed lock resource for this room type and dates
    const lockResource = createRoomLockResource(hotelId, roomTypeId, checkIn, checkOut);

    // Execute booking within distributed lock
    const booking = await withLock(
      lockResource,
      async () => {
        return this._executeBookingTransaction(
          {
            hotelId,
            roomTypeId,
            checkIn,
            checkOut,
            roomCount,
            guestCount,
            guestFirstName,
            guestLastName,
            guestEmail,
            guestPhone,
            specialRequests,
            idempotencyKey,
          },
          userId
        );
      },
      {
        ttlMs: 30000, // 30 second lock
        retryCount: 3,
        retryDelayMs: 100,
      }
    );

    // Cache idempotency result
    await cacheIdempotencyResult(idempotencyKey, booking);

    // Record metrics
    const durationSeconds = (Date.now() - startTime) / 1000;
    metrics.bookingDurationSeconds.observe(durationSeconds);
    metrics.bookingsCreatedTotal.inc({ status: 'reserved', hotel_id: hotelId });
    metrics.bookingRevenueTotal.inc(
      { hotel_id: hotelId, room_type_id: roomTypeId },
      Math.round(booking.totalPrice * 100) // Revenue in cents
    );

    logger.info(
      {
        bookingId: booking.id,
        hotelId,
        roomTypeId,
        checkIn,
        checkOut,
        totalPrice: booking.totalPrice,
        durationSeconds,
      },
      'Booking created successfully'
    );

    return booking;
  }

  /**
   * Execute the booking transaction with pessimistic locking
   * Called within a distributed lock for additional safety
   */
  async _executeBookingTransaction(bookingData, userId) {
    const {
      hotelId,
      roomTypeId,
      checkIn,
      checkOut,
      roomCount,
      guestCount,
      guestFirstName,
      guestLastName,
      guestEmail,
      guestPhone,
      specialRequests,
      idempotencyKey,
    } = bookingData;

    const client = await db.getClient();

    try {
      await client.query('BEGIN');

      // Lock the room type row (pessimistic locking)
      await client.query(
        'SELECT id FROM room_types WHERE id = $1 AND hotel_id = $2 FOR UPDATE',
        [roomTypeId, hotelId]
      );

      // Get total rooms
      const roomResult = await client.query(
        'SELECT total_count, base_price FROM room_types WHERE id = $1 AND hotel_id = $2 AND is_active = true',
        [roomTypeId, hotelId]
      );

      if (roomResult.rows.length === 0) {
        throw new Error('Room type not found');
      }

      const totalRooms = roomResult.rows[0].total_count;

      // Check availability with lock held
      const bookedResult = await client.query(
        `SELECT COALESCE(MAX(daily_booked), 0) as max_booked
         FROM (
           SELECT d::date as date, COALESCE(SUM(b.room_count), 0) as daily_booked
           FROM generate_series($3::date, $4::date - 1, '1 day') d
           LEFT JOIN bookings b ON b.hotel_id = $1
             AND b.room_type_id = $2
             AND b.status IN ('reserved', 'confirmed')
             AND b.check_in <= d::date
             AND b.check_out > d::date
           GROUP BY d::date
         ) daily`,
        [hotelId, roomTypeId, checkIn, checkOut]
      );

      const maxBooked = parseInt(bookedResult.rows[0].max_booked);
      const availableRooms = totalRooms - maxBooked;

      if (availableRooms < roomCount) {
        throw new Error(`Only ${availableRooms} rooms available for the selected dates`);
      }

      // Calculate total price
      const priceInfo = await roomService.getPricesForRange(roomTypeId, checkIn, checkOut);
      const totalPrice = priceInfo.totalPrice * roomCount;

      // Set reservation expiry
      const reservedUntil = new Date(Date.now() + config.reservationHoldMinutes * 60 * 1000);

      // Create booking
      const bookingResult = await client.query(
        `INSERT INTO bookings
         (user_id, hotel_id, room_type_id, check_in, check_out, room_count, guest_count,
          total_price, status, idempotency_key, reserved_until,
          guest_first_name, guest_last_name, guest_email, guest_phone, special_requests)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          userId,
          hotelId,
          roomTypeId,
          checkIn,
          checkOut,
          roomCount,
          guestCount,
          totalPrice,
          idempotencyKey,
          reservedUntil,
          guestFirstName,
          guestLastName,
          guestEmail,
          guestPhone,
          specialRequests,
        ]
      );

      await client.query('COMMIT');

      // Invalidate availability cache
      await this.invalidateAvailabilityCache(hotelId, roomTypeId, checkIn, checkOut);

      return this.formatBooking(bookingResult.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error, hotelId, roomTypeId }, 'Booking transaction failed');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Confirm a booking (after payment)
   */
  async confirmBooking(bookingId, userId, paymentId = null) {
    const result = await db.query(
      `UPDATE bookings
       SET status = 'confirmed', payment_id = $3
       WHERE id = $1 AND user_id = $2 AND status = 'reserved'
       RETURNING *`,
      [bookingId, userId, paymentId]
    );

    if (result.rows.length === 0) {
      throw new Error('Booking not found or cannot be confirmed');
    }

    const booking = this.formatBooking(result.rows[0]);

    // Record metrics
    metrics.bookingsConfirmedTotal.inc({ hotel_id: booking.hotelId });

    // Invalidate availability cache
    await this.invalidateAvailabilityCache(
      booking.hotelId,
      booking.roomTypeId,
      booking.checkIn,
      booking.checkOut
    );

    logger.info(
      { bookingId, paymentId },
      'Booking confirmed'
    );

    return booking;
  }

  /**
   * Cancel a booking
   */
  async cancelBooking(bookingId, userId, reason = 'user_requested') {
    const result = await db.query(
      `UPDATE bookings
       SET status = 'cancelled'
       WHERE id = $1 AND user_id = $2 AND status IN ('reserved', 'confirmed')
       RETURNING *`,
      [bookingId, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('Booking not found or cannot be cancelled');
    }

    const booking = this.formatBooking(result.rows[0]);

    // Record metrics
    metrics.bookingsCancelledTotal.inc({ hotel_id: booking.hotelId, reason });

    // Invalidate availability cache
    await this.invalidateAvailabilityCache(
      booking.hotelId,
      booking.roomTypeId,
      booking.checkIn,
      booking.checkOut
    );

    logger.info(
      { bookingId, reason },
      'Booking cancelled'
    );

    return booking;
  }

  /**
   * Get booking by ID
   */
  async getBookingById(bookingId, userId = null) {
    let query = `
      SELECT b.*, h.name as hotel_name, h.address as hotel_address, h.city as hotel_city,
             rt.name as room_type_name
      FROM bookings b
      JOIN hotels h ON b.hotel_id = h.id
      JOIN room_types rt ON b.room_type_id = rt.id
      WHERE b.id = $1
    `;
    const params = [bookingId];

    if (userId) {
      query += ' AND b.user_id = $2';
      params.push(userId);
    }

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      ...this.formatBooking(row),
      hotelName: row.hotel_name,
      hotelAddress: row.hotel_address,
      hotelCity: row.hotel_city,
      roomTypeName: row.room_type_name,
    };
  }

  /**
   * Get bookings for a user
   */
  async getBookingsByUser(userId, status = null) {
    let query = `
      SELECT b.*, h.name as hotel_name, h.address as hotel_address, h.city as hotel_city,
             h.images as hotel_images, rt.name as room_type_name
      FROM bookings b
      JOIN hotels h ON b.hotel_id = h.id
      JOIN room_types rt ON b.room_type_id = rt.id
      WHERE b.user_id = $1
    `;
    const params = [userId];

    if (status) {
      query += ' AND b.status = $2';
      params.push(status);
    }

    query += ' ORDER BY b.created_at DESC';

    const result = await db.query(query, params);

    return result.rows.map((row) => ({
      ...this.formatBooking(row),
      hotelName: row.hotel_name,
      hotelAddress: row.hotel_address,
      hotelCity: row.hotel_city,
      hotelImages: row.hotel_images,
      roomTypeName: row.room_type_name,
    }));
  }

  /**
   * Get bookings for a hotel (for hotel admin)
   */
  async getBookingsByHotel(hotelId, ownerId, status = null, startDate = null, endDate = null) {
    // Verify ownership
    const ownerCheck = await db.query(
      'SELECT id FROM hotels WHERE id = $1 AND owner_id = $2',
      [hotelId, ownerId]
    );

    if (ownerCheck.rows.length === 0) {
      throw new Error('Hotel not found or access denied');
    }

    let query = `
      SELECT b.*, u.first_name, u.last_name, u.email as user_email,
             rt.name as room_type_name
      FROM bookings b
      JOIN users u ON b.user_id = u.id
      JOIN room_types rt ON b.room_type_id = rt.id
      WHERE b.hotel_id = $1
    `;
    const params = [hotelId];
    let paramIndex = 2;

    if (status) {
      query += ` AND b.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (startDate) {
      query += ` AND b.check_in >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      query += ` AND b.check_out <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    query += ' ORDER BY b.check_in ASC';

    const result = await db.query(query, params);

    return result.rows.map((row) => ({
      ...this.formatBooking(row),
      userFirstName: row.first_name,
      userLastName: row.last_name,
      userEmail: row.user_email,
      roomTypeName: row.room_type_name,
    }));
  }

  /**
   * Expire stale reservations (to be called by a background job)
   */
  async expireStaleReservations() {
    const result = await db.query(
      `UPDATE bookings
       SET status = 'expired'
       WHERE status = 'reserved' AND reserved_until < NOW()
       RETURNING hotel_id, room_type_id, check_in, check_out`
    );

    // Invalidate cache for expired reservations
    for (const row of result.rows) {
      await this.invalidateAvailabilityCache(
        row.hotel_id,
        row.room_type_id,
        row.check_in,
        row.check_out
      );
    }

    if (result.rowCount > 0) {
      logger.info({ count: result.rowCount }, 'Expired stale reservations');
    }

    return result.rowCount;
  }

  /**
   * Invalidate availability cache for affected date range
   */
  async invalidateAvailabilityCache(hotelId, roomTypeId, checkIn, checkOut) {
    const start = new Date(checkIn);
    const end = new Date(checkOut);

    const months = new Set();
    for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 1)) {
      months.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
    }

    const keysToDelete = [];
    for (const monthKey of months) {
      keysToDelete.push(`availability:${hotelId}:${roomTypeId}:${monthKey}`);
    }

    // Also invalidate the specific check availability cache
    keysToDelete.push(
      `availability:check:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}`
    );

    // Delete all cache keys
    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
      logger.debug(
        { keysDeleted: keysToDelete.length },
        'Invalidated availability cache'
      );
    }
  }

  /**
   * Format a booking row from the database
   */
  formatBooking(row) {
    return {
      id: row.id,
      userId: row.user_id,
      hotelId: row.hotel_id,
      roomTypeId: row.room_type_id,
      checkIn: row.check_in,
      checkOut: row.check_out,
      roomCount: row.room_count,
      guestCount: row.guest_count,
      totalPrice: parseFloat(row.total_price),
      status: row.status,
      paymentId: row.payment_id,
      reservedUntil: row.reserved_until,
      guestFirstName: row.guest_first_name,
      guestLastName: row.guest_last_name,
      guestEmail: row.guest_email,
      guestPhone: row.guest_phone,
      specialRequests: row.special_requests,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

module.exports = new BookingService();
