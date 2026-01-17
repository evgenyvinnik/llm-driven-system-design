import { pool, redis } from '../db/index.js';
import {
  type AvailabilityRule,
  type CreateAvailabilityRuleInput,
  type TimeSlot,
} from '../types/index.js';
import { meetingTypeService } from './meetingTypeService.js';
import { bookingService } from './bookingService.js';
import { logger } from '../shared/logger.js';
import {
  availabilityChecksTotal,
  availabilityCalculationDuration,
  recordAvailabilityCheck,
  recordCacheOperation,
} from '../shared/metrics.js';
import { RETENTION_CONFIG } from '../shared/config.js';
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

/**
 * Service for managing user availability and calculating bookable time slots.
 * This is the core scheduling engine that determines when invitees can book meetings.
 * Handles weekly recurring availability rules and integrates with booking data
 * to prevent double-booking.
 *
 * WHY METRICS ENABLE AVAILABILITY OPTIMIZATION:
 * Tracking availability calculations provides insights into:
 * 1. Cache effectiveness - Are we serving most requests from cache?
 * 2. Calculation latency - How long do complex availability queries take?
 * 3. Popular time slots - Which dates are queried most frequently?
 *
 * This data enables proactive optimization:
 * - Adjust cache TTL based on hit rate
 * - Pre-warm cache for high-traffic users
 * - Identify performance bottlenecks in slot calculation
 */
export class AvailabilityService {
  /**
   * Creates a single availability rule for a user.
   * Invalidates relevant caches after creation.
   * @param userId - The UUID of the user
   * @param input - Rule configuration with day of week and time range
   * @returns The newly created availability rule
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

    logger.info(
      { userId, dayOfWeek: input.day_of_week },
      'Created availability rule'
    );

    return result.rows[0];
  }

  /**
   * Replaces all availability rules for a user in a single transaction.
   * Used when updating the entire weekly schedule at once.
   * @param userId - The UUID of the user
   * @param rules - Array of new availability rules to set
   * @returns Array of the newly created availability rules
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

      logger.info(
        { userId, ruleCount: rules.length },
        'Updated availability rules'
      );

      return insertedRules;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves all active availability rules for a user.
   * Results are cached in Redis for the configured TTL.
   * @param userId - The UUID of the user
   * @returns Array of availability rules sorted by day and time
   */
  async getRules(userId: string): Promise<AvailabilityRule[]> {
    const cacheKey = `availability_rules:${userId}`;
    const cached = await redis.get(cacheKey);

    if (cached) {
      recordCacheOperation('hit', 'availability');
      return JSON.parse(cached);
    }

    recordCacheOperation('miss', 'availability');

    const result = await pool.query(
      `SELECT * FROM availability_rules
       WHERE user_id = $1 AND is_active = true
       ORDER BY day_of_week, start_time`,
      [userId]
    );

    const ttl = RETENTION_CONFIG.AVAILABILITY_CACHE_TTL_MINUTES * 60;
    await redis.setex(cacheKey, ttl, JSON.stringify(result.rows));
    recordCacheOperation('set', 'availability');

    return result.rows;
  }

  /**
   * Calculates available time slots for a meeting type on a specific date.
   * This is the core availability algorithm that:
   * 1. Gets the host's availability rules for the day
   * 2. Fetches existing bookings to identify busy periods
   * 3. Computes gaps and generates bookable slots with buffer times
   * 4. Filters out past slots and enforces daily booking limits
   * Results are cached for the configured TTL.
   *
   * METRICS:
   * - Tracks cache hit/miss rates
   * - Records calculation duration for performance monitoring
   *
   * @param meetingTypeId - The UUID of the meeting type
   * @param dateStr - Date in YYYY-MM-DD format
   * @param inviteeTimezone - The invitee's timezone for display purposes
   * @returns Array of available time slots in ISO 8601 format
   * @throws Error if meeting type not found
   */
  async getAvailableSlots(
    meetingTypeId: string,
    dateStr: string,
    inviteeTimezone: string
  ): Promise<TimeSlot[]> {
    const startTime = Date.now();
    const slotLogger = logger.child({
      operation: 'getAvailableSlots',
      meetingTypeId,
      date: dateStr,
    });

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
      const duration = (Date.now() - startTime) / 1000;
      availabilityCalculationDuration.observe({ cache_hit: 'true' }, duration);
      recordAvailabilityCheck(true);
      slotLogger.debug({ duration, cached: true }, 'Returning cached slots');
      return JSON.parse(cached);
    }

    recordAvailabilityCheck(false);

    // Get the day of week in host's timezone
    const date = parseISO(dateStr);
    const dayOfWeek = getDayOfWeekInTimezone(date, hostTimezone);

    // Get availability rules for this day
    const rules = await this.getRules(hostUserId);
    const dayRules = rules.filter((r) => r.day_of_week === dayOfWeek);

    if (dayRules.length === 0) {
      const duration = (Date.now() - startTime) / 1000;
      availabilityCalculationDuration.observe({ cache_hit: 'false' }, duration);
      slotLogger.debug({ duration }, 'No availability rules for this day');
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
        const duration = (Date.now() - startTime) / 1000;
        availabilityCalculationDuration.observe({ cache_hit: 'false' }, duration);
        slotLogger.debug({ duration }, 'Max bookings per day reached');
        return [];
      }

      // Limit remaining slots
      const remainingSlots = meetingType.max_bookings_per_day - confirmedBookingsCount;
      if (allSlots.length > remainingSlots) {
        allSlots.splice(remainingSlots);
      }
    }

    // Cache for configured TTL
    const ttl = RETENTION_CONFIG.AVAILABILITY_CACHE_TTL_MINUTES * 60;
    await redis.setex(cacheKey, ttl, JSON.stringify(allSlots));
    recordCacheOperation('set', 'slots');

    const duration = (Date.now() - startTime) / 1000;
    availabilityCalculationDuration.observe({ cache_hit: 'false' }, duration);

    slotLogger.debug(
      { duration, slotCount: allSlots.length },
      'Calculated available slots'
    );

    return allSlots;
  }

  /**
   * Finds all dates with available slots within a given range.
   * Useful for calendar displays that highlight bookable dates.
   * @param meetingTypeId - The UUID of the meeting type
   * @param inviteeTimezone - The invitee's timezone
   * @param daysAhead - Number of days to check (default 30)
   * @returns Array of date strings (YYYY-MM-DD) that have availability
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
   * Deletes a single availability rule.
   * Validates ownership and invalidates related caches.
   * @param id - The UUID of the rule to delete
   * @param userId - The UUID of the user (for ownership verification)
   * @returns true if deleted, false if not found or not owned by user
   */
  async deleteRule(id: string, userId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM availability_rules WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (result.rowCount && result.rowCount > 0) {
      await this.invalidateCache(userId);
      logger.info({ userId, ruleId: id }, 'Deleted availability rule');
      return true;
    }

    return false;
  }

  /**
   * Invalidates all availability-related caches for a user.
   * Called after any change to availability rules or bookings.
   * @param userId - The UUID of the user whose caches to invalidate
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
      recordCacheOperation('delete', 'availability');
    }
  }
}

/** Singleton instance of AvailabilityService for application-wide use */
export const availabilityService = new AvailabilityService();
