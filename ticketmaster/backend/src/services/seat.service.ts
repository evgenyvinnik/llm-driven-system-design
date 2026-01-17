import { query, withTransaction } from '../db/pool.js';
import redis from '../db/redis.js';
import type { EventSeat, SeatAvailability, SeatInfo } from '../types/index.js';

const HOLD_DURATION = 600; // 10 minutes in seconds
const AVAILABILITY_CACHE_TTL = 5; // 5 seconds during high traffic

export class SeatService {
  async getSeatAvailability(eventId: string, section?: string): Promise<SeatAvailability[]> {
    const cacheKey = `availability:${eventId}:${section || 'all'}`;

    // Try cache first (very short TTL for availability)
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    let queryText = `
      SELECT section, row, seat_number, id, price, price_tier, status
      FROM event_seats
      WHERE event_id = $1
    `;
    const params: unknown[] = [eventId];

    if (section) {
      queryText += ' AND section = $2';
      params.push(section);
    }

    queryText += ' ORDER BY section, row, seat_number::int';

    const result = await query(queryText, params);

    // Group by section
    const sectionMap = new Map<string, SeatAvailability>();

    for (const row of result.rows) {
      const sectionName = row.section as string;
      if (!sectionMap.has(sectionName)) {
        sectionMap.set(sectionName, {
          section: sectionName,
          available: 0,
          total: 0,
          min_price: Infinity,
          max_price: 0,
          seats: [],
        });
      }

      const sectionData = sectionMap.get(sectionName)!;
      sectionData.total++;

      const price = parseFloat(row.price);
      sectionData.min_price = Math.min(sectionData.min_price, price);
      sectionData.max_price = Math.max(sectionData.max_price, price);

      if (row.status === 'available') {
        sectionData.available++;
      }

      sectionData.seats.push({
        id: row.id,
        row: row.row,
        seat_number: row.seat_number,
        price: price,
        price_tier: row.price_tier,
        status: row.status,
      });
    }

    const availability = Array.from(sectionMap.values()).map((s) => ({
      ...s,
      min_price: s.min_price === Infinity ? 0 : s.min_price,
    }));

    // Cache briefly
    await redis.setex(cacheKey, AVAILABILITY_CACHE_TTL, JSON.stringify(availability));

    return availability;
  }

  async getSectionSeats(eventId: string, section: string): Promise<SeatInfo[]> {
    const result = await query(
      `SELECT id, row, seat_number, price, price_tier, status
       FROM event_seats
       WHERE event_id = $1 AND section = $2
       ORDER BY row, seat_number::int`,
      [eventId, section]
    );

    return result.rows.map((row) => ({
      id: row.id,
      row: row.row,
      seat_number: row.seat_number,
      price: parseFloat(row.price),
      price_tier: row.price_tier,
      status: row.status,
    }));
  }

  async reserveSeats(
    sessionId: string,
    eventId: string,
    seatIds: string[]
  ): Promise<{ seats: EventSeat[]; expiresAt: Date }> {
    const reservedSeats: EventSeat[] = [];
    const failedSeats: string[] = [];

    // Try to acquire Redis locks first (fast path)
    for (const seatId of seatIds) {
      const lockKey = `seat_lock:${eventId}:${seatId}`;
      const acquired = await redis.set(lockKey, sessionId, 'EX', HOLD_DURATION, 'NX');

      if (acquired) {
        reservedSeats.push({ id: seatId } as EventSeat);
      } else {
        failedSeats.push(seatId);
      }
    }

    if (failedSeats.length > 0) {
      // Release any seats we did acquire
      for (const seat of reservedSeats) {
        await this.releaseSeatLock(eventId, seat.id, sessionId);
      }
      throw new Error(`Seats not available: ${failedSeats.join(', ')}`);
    }

    // Update database
    const expiresAt = new Date(Date.now() + HOLD_DURATION * 1000);

    try {
      await withTransaction(async (client) => {
        // Lock rows for update
        const checkResult = await client.query(
          `SELECT id, status FROM event_seats
           WHERE event_id = $1 AND id = ANY($2)
           FOR UPDATE NOWAIT`,
          [eventId, seatIds]
        );

        // Verify all seats are available
        for (const row of checkResult.rows) {
          if (row.status !== 'available') {
            throw new Error(`Seat ${row.id} is not available`);
          }
        }

        // Update seats to held status
        await client.query(
          `UPDATE event_seats
           SET status = 'held',
               held_until = $1,
               held_by_session = $2,
               updated_at = NOW()
           WHERE event_id = $3 AND id = ANY($4)`,
          [expiresAt, sessionId, eventId, seatIds]
        );

        // Update available seats count
        await client.query(
          `UPDATE events
           SET available_seats = available_seats - $1,
               updated_at = NOW()
           WHERE id = $2`,
          [seatIds.length, eventId]
        );
      });

      // Get full seat details
      const seatsResult = await query(
        `SELECT * FROM event_seats WHERE id = ANY($1)`,
        [seatIds]
      );

      // Store reservation in Redis for quick lookup
      const reservation = {
        session_id: sessionId,
        event_id: eventId,
        seat_ids: seatIds,
        total_price: seatsResult.rows.reduce((sum, s) => sum + parseFloat(s.price), 0),
        expires_at: expiresAt.toISOString(),
      };
      await redis.setex(
        `reservation:${sessionId}`,
        HOLD_DURATION,
        JSON.stringify(reservation)
      );

      // Invalidate availability cache
      await this.invalidateAvailabilityCache(eventId);

      return { seats: seatsResult.rows, expiresAt };
    } catch (error) {
      // Release Redis locks on database error
      for (const seatId of seatIds) {
        await this.releaseSeatLock(eventId, seatId, sessionId);
      }
      throw error;
    }
  }

  async releaseSeats(sessionId: string, eventId: string, seatIds: string[]): Promise<void> {
    // Release Redis locks
    for (const seatId of seatIds) {
      await this.releaseSeatLock(eventId, seatId, sessionId);
    }

    // Update database
    await query(
      `UPDATE event_seats
       SET status = 'available',
           held_until = NULL,
           held_by_session = NULL,
           updated_at = NOW()
       WHERE event_id = $1
       AND id = ANY($2)
       AND held_by_session = $3`,
      [eventId, seatIds, sessionId]
    );

    // Update available seats count
    await query(
      `UPDATE events
       SET available_seats = (
         SELECT COUNT(*) FROM event_seats
         WHERE event_id = events.id AND status = 'available'
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [eventId]
    );

    // Delete reservation from Redis
    await redis.del(`reservation:${sessionId}`);

    // Invalidate availability cache
    await this.invalidateAvailabilityCache(eventId);
  }

  async getReservation(sessionId: string): Promise<{
    event_id: string;
    seat_ids: string[];
    total_price: number;
    expires_at: Date;
    seats: EventSeat[];
  } | null> {
    const cached = await redis.get(`reservation:${sessionId}`);
    if (!cached) {
      return null;
    }

    const reservation = JSON.parse(cached);
    const seats = await query(
      'SELECT * FROM event_seats WHERE id = ANY($1)',
      [reservation.seat_ids]
    );

    return {
      event_id: reservation.event_id,
      seat_ids: reservation.seat_ids,
      total_price: reservation.total_price,
      expires_at: new Date(reservation.expires_at),
      seats: seats.rows,
    };
  }

  async cleanupExpiredHolds(): Promise<number> {
    // Find expired holds
    const expired = await query(`
      SELECT id, event_id, held_by_session
      FROM event_seats
      WHERE status = 'held'
      AND held_until < NOW()
    `);

    if (expired.rows.length === 0) {
      return 0;
    }

    const eventIds = new Set<string>();

    for (const seat of expired.rows) {
      // Release in database
      await query(
        `UPDATE event_seats
         SET status = 'available',
             held_until = NULL,
             held_by_session = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'held'`,
        [seat.id]
      );

      // Release Redis lock
      const lockKey = `seat_lock:${seat.event_id}:${seat.id}`;
      await redis.del(lockKey);

      eventIds.add(seat.event_id);
    }

    // Update available seats count and invalidate caches
    for (const eventId of eventIds) {
      await query(
        `UPDATE events
         SET available_seats = (
           SELECT COUNT(*) FROM event_seats
           WHERE event_id = events.id AND status = 'available'
         ),
         updated_at = NOW()
         WHERE id = $1`,
        [eventId]
      );

      await this.invalidateAvailabilityCache(eventId);
    }

    return expired.rows.length;
  }

  private async releaseSeatLock(eventId: string, seatId: string, sessionId: string): Promise<void> {
    const lockKey = `seat_lock:${eventId}:${seatId}`;
    const currentHolder = await redis.get(lockKey);
    if (currentHolder === sessionId) {
      await redis.del(lockKey);
    }
  }

  private async invalidateAvailabilityCache(eventId: string): Promise<void> {
    const keys = await redis.keys(`availability:${eventId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.del(`event:${eventId}`);
  }
}

export const seatService = new SeatService();
