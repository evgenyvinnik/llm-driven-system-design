import { pool, redis } from '../db/index.js';
import {
  type AvailabilityRule,
  type CreateAvailabilityRuleInput,
  type TimeSlot,
} from '../types/index.js';
import { meetingTypeService } from './meetingTypeService.js';
import { bookingService } from './bookingService.js';
import {
  createDateWithTime,
  getDayOfWeekInTimezone,
  mergeIntervals,
  findGaps,
  generateSlots,
  type TimeInterval,
  utcToLocal,
  formatInTimezone,
} from '../utils/time.js';
import { v4 as uuidv4 } from 'uuid';
import { parseISO, addDays } from 'date-fns';

export class AvailabilityService {
  /**
   * Create a new availability rule
   */
  async createRule(userId: string, input: CreateAvailabilityRuleInput): Promise<AvailabilityRule> {
    const id = uuidv4();

    const result = await pool.query(
      `INSERT INTO availability_rules (id, user_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, userId, input.day_of_week, input.start_time, input.end_time]
    );

    // Invalidate cache
    await this.invalidateCache(userId);

    return result.rows[0];
  }

  /**
   * Set availability rules in bulk (replaces existing rules)
   */
  async setRules(userId: string, rules: CreateAvailabilityRuleInput[]): Promise<AvailabilityRule[]> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Delete existing rules
      await client.query(
        `DELETE FROM availability_rules WHERE user_id = $1`,
        [userId]
      );

      // Insert new rules
      const insertedRules: AvailabilityRule[] = [];
      for (const rule of rules) {
        const id = uuidv4();
        const result = await client.query(
          `INSERT INTO availability_rules (id, user_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [id, userId, rule.day_of_week, rule.start_time, rule.end_time]
        );
        insertedRules.push(result.rows[0]);
      }

      await client.query('COMMIT');

      // Invalidate cache
      await this.invalidateCache(userId);

      return insertedRules;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get availability rules for a user
   */
  async getRules(userId: string): Promise<AvailabilityRule[]> {
    const cacheKey = `availability_rules:${userId}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    const result = await pool.query(
      `SELECT * FROM availability_rules
       WHERE user_id = $1 AND is_active = true
       ORDER BY day_of_week, start_time`,
      [userId]
    );

    await redis.setex(cacheKey, 300, JSON.stringify(result.rows));

    return result.rows;
  }

  /**
   * Get available time slots for a meeting type on a specific date
   */
  async getAvailableSlots(
    meetingTypeId: string,
    dateStr: string,
    inviteeTimezone: string
  ): Promise<TimeSlot[]> {
    // Get the meeting type
    const meetingType = await meetingTypeService.findByIdWithUser(meetingTypeId);
    if (!meetingType) {
      throw new Error('Meeting type not found');
    }

    const hostTimezone = meetingType.user_timezone;
    const hostUserId = meetingType.user_id;

    // Check cache first
    const cacheKey = `slots:${meetingTypeId}:${dateStr}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Get the day of week in host's timezone
    const date = parseISO(dateStr);
    const dayOfWeek = getDayOfWeekInTimezone(date, hostTimezone);

    // Get availability rules for this day
    const rules = await this.getRules(hostUserId);
    const dayRules = rules.filter((r) => r.day_of_week === dayOfWeek);

    if (dayRules.length === 0) {
      return [];
    }

    // Convert availability rules to time intervals in UTC
    const availableIntervals: TimeInterval[] = dayRules.map((rule) => ({
      start: createDateWithTime(dateStr, rule.start_time, hostTimezone),
      end: createDateWithTime(dateStr, rule.end_time, hostTimezone),
    }));

    // Get existing bookings for this date
    const existingBookings = await bookingService.getBookingsForDateRange(
      hostUserId,
      createDateWithTime(dateStr, '00:00', hostTimezone),
      createDateWithTime(dateStr, '23:59', hostTimezone)
    );

    // Convert bookings to busy intervals (including buffer times)
    const busyIntervals: TimeInterval[] = existingBookings.map((booking) => {
      const bufferBefore = meetingType.buffer_before_minutes;
      const bufferAfter = meetingType.buffer_after_minutes;
      return {
        start: new Date(new Date(booking.start_time).getTime() - bufferBefore * 60 * 1000),
        end: new Date(new Date(booking.end_time).getTime() + bufferAfter * 60 * 1000),
      };
    });

    // Calculate available slots from each availability window
    const allSlots: TimeSlot[] = [];
    const now = new Date();

    for (const availableInterval of availableIntervals) {
      // Find gaps (times not covered by bookings) within this availability window
      const gaps = findGaps(
        availableInterval.start,
        availableInterval.end,
        busyIntervals,
        meetingType.duration_minutes
      );

      // Generate slots from gaps
      const slots = generateSlots(
        gaps,
        meetingType.duration_minutes,
        meetingType.buffer_before_minutes,
        meetingType.buffer_after_minutes
      );

      // Filter out past slots and format for response
      for (const slot of slots) {
        if (slot.start > now) {
          allSlots.push({
            start: slot.start.toISOString(),
            end: slot.end.toISOString(),
          });
        }
      }
    }

    // Check max bookings per day limit
    if (meetingType.max_bookings_per_day) {
      const confirmedBookingsCount = existingBookings.filter(
        (b) => b.status === 'confirmed' && b.meeting_type_id === meetingTypeId
      ).length;

      if (confirmedBookingsCount >= meetingType.max_bookings_per_day) {
        return [];
      }

      // Limit remaining slots
      const remainingSlots = meetingType.max_bookings_per_day - confirmedBookingsCount;
      if (allSlots.length > remainingSlots) {
        allSlots.splice(remainingSlots);
      }
    }

    // Cache for 5 minutes
    await redis.setex(cacheKey, 300, JSON.stringify(allSlots));

    return allSlots;
  }

  /**
   * Get available dates for a meeting type (next 30 days by default)
   */
  async getAvailableDates(
    meetingTypeId: string,
    inviteeTimezone: string,
    daysAhead: number = 30
  ): Promise<string[]> {
    const availableDates: string[] = [];
    const today = new Date();

    for (let i = 0; i < daysAhead; i++) {
      const date = addDays(today, i);
      const dateStr = formatInTimezone(date, inviteeTimezone, 'yyyy-MM-dd');

      const slots = await this.getAvailableSlots(meetingTypeId, dateStr, inviteeTimezone);
      if (slots.length > 0) {
        availableDates.push(dateStr);
      }
    }

    return availableDates;
  }

  /**
   * Delete an availability rule
   */
  async deleteRule(id: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM availability_rules WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rowCount && result.rowCount > 0) {
      await this.invalidateCache(userId);
      return true;
    }

    return false;
  }

  /**
   * Invalidate availability cache for a user
   */
  async invalidateCache(userId: string): Promise<void> {
    // Get all meeting types for this user and invalidate their slot caches
    const meetingTypes = await meetingTypeService.findByUserId(userId);

    const keys = [`availability_rules:${userId}`];
    for (const mt of meetingTypes) {
      // Invalidate all slot caches for this meeting type
      const slotKeys = await redis.keys(`slots:${mt.id}:*`);
      keys.push(...slotKeys);
    }

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

export const availabilityService = new AvailabilityService();
