import { pool, redis } from '../db/index.js';
import {
  type Booking,
  type CreateBookingInput,
  type BookingWithDetails,
  type DashboardStats,
} from '../types/index.js';
import { meetingTypeService } from './meetingTypeService.js';
import { emailService } from './emailService.js';
import { logger } from '../shared/logger.js';
import {
  bookingOperationsTotal,
  bookingCreationDuration,
  activeBookingsGauge,
  doubleBookingPrevented,
  emailNotificationsTotal,
  recordBookingOperation,
} from '../shared/metrics.js';
import { idempotencyService, IdempotencyService } from '../shared/idempotency.js';
import { IDEMPOTENCY_CONFIG } from '../shared/config.js';
import { queueService } from '../shared/queue.js';
import { v4 as uuidv4 } from 'uuid';
import { parseISO, addMinutes, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from 'date-fns';

/**
 * Service for managing bookings (scheduled meetings).
 * Handles the full booking lifecycle: creation, retrieval, rescheduling, and cancellation.
 * Implements double-booking prevention using PostgreSQL row-level locking and
 * optimistic concurrency control via version fields.
 *
 * Also implements idempotency to prevent duplicate bookings from network retries.
 * 
 * Notifications are published to RabbitMQ for async processing by workers.
 */
export class BookingService {
  /**
   * Creates a new booking with double-booking prevention and idempotency handling.
   *
   * IDEMPOTENCY:
   * If a client-provided idempotency key is present, the system will:
   * 1. Check if this request was already processed
   * 2. Return the cached result if found
   * 3. Otherwise process the request and cache the result
   *
   * This prevents duplicate bookings when clients retry failed requests.
   *
   * @param input - Booking details including meeting type, time, and invitee info
   * @param idempotencyKey - Optional client-provided idempotency key
   * @returns The newly created booking or cached result
   * @throws Error if slot is unavailable, meeting type not found, or limit reached
   */
  async createBooking(
    input: CreateBookingInput,
    idempotencyKey?: string
  ): Promise<{ booking: Booking; cached: boolean }> {
    const startTimer = Date.now();
    const bookingLogger = logger.child({
      operation: 'createBooking',
      meetingTypeId: input.meeting_type_id,
      startTime: input.start_time,
      inviteeEmail: input.invitee_email,
    });

    // Generate idempotency key if not provided
    const effectiveIdempotencyKey =
      idempotencyKey ||
      IdempotencyService.generateBookingKey(
        input.meeting_type_id,
        input.start_time,
        input.invitee_email
      );

    // Check for existing result with this idempotency key
    const existingResult = await idempotencyService.checkIdempotency(effectiveIdempotencyKey);
    if (existingResult.found && existingResult.result) {
      bookingLogger.info('Returning cached booking result (idempotent)');
      return {
        booking: existingResult.result as Booking,
        cached: true,
      };
    }

    // Acquire lock to prevent concurrent processing of same request
    const lockAcquired = await idempotencyService.acquireLock(effectiveIdempotencyKey);
    if (!lockAcquired) {
      bookingLogger.warn('Could not acquire idempotency lock, another request is processing');
      // Wait briefly and check for result again
      await new Promise((resolve) => setTimeout(resolve, 100));
      const retryResult = await idempotencyService.checkIdempotency(effectiveIdempotencyKey);
      if (retryResult.found && retryResult.result) {
        return {
          booking: retryResult.result as Booking,
          cached: true,
        };
      }
      throw new Error('Request is being processed. Please wait and try again.');
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get meeting type details
      const meetingType = await meetingTypeService.findByIdWithUser(input.meeting_type_id);
      if (!meetingType) {
        throw new Error('Meeting type not found');
      }

      if (!meetingType.is_active) {
        throw new Error('Meeting type is not active');
      }

      const startTime = parseISO(input.start_time);
      const endTime = addMinutes(startTime, meetingType.duration_minutes);

      // Lock the host's row to serialize concurrent booking attempts
      await client.query(
        `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
        [meetingType.user_id]
      );

      // Check for overlapping bookings (including buffer times)
      const bufferStart = addMinutes(startTime, -meetingType.buffer_before_minutes);
      const bufferEnd = addMinutes(endTime, meetingType.buffer_after_minutes);

      const conflicts = await client.query(
        `SELECT id FROM bookings
         WHERE host_user_id = $1
           AND status = 'confirmed'
           AND start_time < $2
           AND end_time > $3`,
        [meetingType.user_id, bufferEnd.toISOString(), bufferStart.toISOString()]
      );

      if (conflicts.rows.length > 0) {
        // Track prevented double-booking
        doubleBookingPrevented.inc();
        recordBookingOperation('create', 'conflict');
        bookingLogger.warn('Double booking prevented - slot no longer available');
        throw new Error('Time slot is no longer available. Please select another time.');
      }

      // Check max bookings per day if set
      if (meetingType.max_bookings_per_day) {
        const dayStart = new Date(startTime);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(startTime);
        dayEnd.setHours(23, 59, 59, 999);

        const dayBookings = await client.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE meeting_type_id = $1
             AND status = 'confirmed'
             AND start_time >= $2
             AND start_time <= $3`,
          [input.meeting_type_id, dayStart.toISOString(), dayEnd.toISOString()]
        );

        if (parseInt(dayBookings.rows[0].count) >= meetingType.max_bookings_per_day) {
          recordBookingOperation('create', 'failure');
          throw new Error('Maximum bookings for this day has been reached.');
        }
      }

      // Create the booking with idempotency key
      const id = uuidv4();
      const result = await client.query(
        `INSERT INTO bookings
         (id, meeting_type_id, host_user_id, invitee_name, invitee_email,
          start_time, end_time, invitee_timezone, status, notes, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, $10)
         RETURNING *`,
        [
          id,
          input.meeting_type_id,
          meetingType.user_id,
          input.invitee_name,
          input.invitee_email,
          startTime.toISOString(),
          endTime.toISOString(),
          input.invitee_timezone,
          input.notes || null,
          effectiveIdempotencyKey,
        ]
      );

      await client.query('COMMIT');

      const booking = result.rows[0];

      // Record success metrics
      const duration = (Date.now() - startTimer) / 1000;
      bookingCreationDuration.observe({ status: 'success' }, duration);
      recordBookingOperation('create', 'success');

      // Store result for idempotency
      await idempotencyService.storeResult(effectiveIdempotencyKey, booking, 201);

      // Invalidate availability cache
      await this.invalidateAvailabilityCache(meetingType.user_id, input.meeting_type_id);

      // Update active bookings gauge
      await this.updateActiveBookingsGauge();

      // Publish notification to RabbitMQ for async processing
      this.publishBookingConfirmation(booking, meetingType).catch((error) => {
        bookingLogger.error({ error }, 'Failed to publish booking notification to queue');
      });

      // Schedule reminders (24h and 1h before meeting)
      this.scheduleReminders(booking).catch((error) => {
        bookingLogger.error({ error }, 'Failed to schedule reminders');
      });

      // Also send confirmation emails directly (fallback/legacy path)
      this.sendConfirmationEmails(booking, meetingType).catch((error) => {
        bookingLogger.error({ error }, 'Failed to send confirmation emails');
        emailNotificationsTotal.inc({ type: 'confirmation', status: 'failure' });
      });

      bookingLogger.info({ bookingId: booking.id, duration }, 'Booking created successfully');

      return { booking, cached: false };
    } catch (error) {
      await client.query('ROLLBACK');

      // Record failure metrics
      const duration = (Date.now() - startTimer) / 1000;
      bookingCreationDuration.observe({ status: 'failure' }, duration);

      bookingLogger.error({ error }, 'Failed to create booking');
      throw error;
    } finally {
      client.release();
      // Release idempotency lock
      await idempotencyService.releaseLock(effectiveIdempotencyKey);
    }
  }

  /**
   * Publishes booking confirmation notification to RabbitMQ.
   * @param booking - The newly created booking
   * @param meetingType - Meeting type details including host info
   */
  private async publishBookingConfirmation(
    booking: Booking,
    meetingType: { name: string; user_name: string; user_email: string; id: string }
  ): Promise<void> {
    try {
      await queueService.publishNotification('booking_confirmed', {
        bookingId: booking.id,
        hostUserId: booking.host_user_id,
        inviteeEmail: booking.invitee_email,
        inviteeName: booking.invitee_name,
        meetingTypeName: meetingType.name,
        meetingTypeId: meetingType.id,
        hostName: meetingType.user_name,
        hostEmail: meetingType.user_email,
        startTime: booking.start_time.toString(),
        endTime: booking.end_time.toString(),
        inviteeTimezone: booking.invitee_timezone,
        notes: booking.notes || undefined,
      });
    } catch (error) {
      logger.error({ error, bookingId: booking.id }, 'Failed to publish booking confirmation');
      throw error;
    }
  }

  /**
   * Schedules reminder notifications for a booking.
   * Schedules reminders for 24 hours and 1 hour before the meeting.
   * @param booking - The booking to schedule reminders for
   */
  private async scheduleReminders(booking: Booking): Promise<void> {
    const startTime = new Date(booking.start_time);
    const now = new Date();

    // Schedule 24-hour reminder
    const reminder24h = new Date(startTime.getTime() - 24 * 60 * 60 * 1000);
    if (reminder24h > now) {
      await queueService.scheduleReminder(booking.id, reminder24h.toISOString(), {
        hoursUntil: 24,
        inviteeEmail: booking.invitee_email,
        inviteeName: booking.invitee_name,
        startTime: booking.start_time.toString(),
        inviteeTimezone: booking.invitee_timezone,
      });
    }

    // Schedule 1-hour reminder
    const reminder1h = new Date(startTime.getTime() - 60 * 60 * 1000);
    if (reminder1h > now) {
      await queueService.scheduleReminder(booking.id, reminder1h.toISOString(), {
        hoursUntil: 1,
        inviteeEmail: booking.invitee_email,
        inviteeName: booking.invitee_name,
        startTime: booking.start_time.toString(),
        inviteeTimezone: booking.invitee_timezone,
      });
    }
  }

  /**
   * Retrieves a booking by its unique ID.
   * @param id - The UUID of the booking
   * @returns The booking if found, null otherwise
   */
  async findById(id: string): Promise<Booking | null> {
    const result = await pool.query(
      `SELECT * FROM bookings WHERE id = $1`,
      [id]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Retrieves a booking with full related entity details.
   * Includes meeting type name, duration, and host information.
   * @param id - The UUID of the booking
   * @returns Booking with details if found, null otherwise
   */
  async findByIdWithDetails(id: string): Promise<BookingWithDetails | null> {
    const result = await pool.query(
      `SELECT b.*,
              mt.name as meeting_type_name,
              mt.duration_minutes as meeting_type_duration,
              u.name as host_name,
              u.email as host_email
       FROM bookings b
       JOIN meeting_types mt ON b.meeting_type_id = mt.id
       JOIN users u ON b.host_user_id = u.id
       WHERE b.id = $1`,
      [id]
    );

    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Retrieves all bookings for a host user with optional filtering.
   * Includes full booking details with meeting type and host info.
   * @param userId - The UUID of the host user
   * @param status - Optional status filter ('confirmed', 'cancelled', 'rescheduled')
   * @param upcoming - If true, only returns future bookings
   * @returns Array of bookings sorted by start time ascending
   */
  async getBookingsForUser(
    userId: string,
    status?: string,
    upcoming: boolean = false
  ): Promise<BookingWithDetails[]> {
    let query = `
      SELECT b.*,
             mt.name as meeting_type_name,
             mt.duration_minutes as meeting_type_duration,
             u.name as host_name,
             u.email as host_email
      FROM bookings b
      JOIN meeting_types mt ON b.meeting_type_id = mt.id
      JOIN users u ON b.host_user_id = u.id
      WHERE b.host_user_id = $1
    `;
    const params: (string | Date)[] = [userId];
    let paramIndex = 2;

    if (status) {
      query += ` AND b.status = $${paramIndex++}`;
      params.push(status);
    }

    if (upcoming) {
      query += ` AND b.start_time > NOW()`;
    }

    query += ` ORDER BY b.start_time ASC`;

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Retrieves confirmed bookings within a date range for availability calculation.
   * Used internally to determine busy periods when computing available slots.
   * @param userId - The UUID of the host user
   * @param startDate - Range start (inclusive)
   * @param endDate - Range end (inclusive)
   * @returns Array of confirmed bookings in the range
   */
  async getBookingsForDateRange(
    userId: string,
    startDate: Date,
    endDate: Date
  ): Promise<Booking[]> {
    const result = await pool.query(
      `SELECT * FROM bookings
       WHERE host_user_id = $1
         AND status = 'confirmed'
         AND start_time >= $2
         AND start_time <= $3
       ORDER BY start_time`,
      [userId, startDate.toISOString(), endDate.toISOString()]
    );

    return result.rows;
  }

  /**
   * Reschedules a booking to a new time.
   * Uses optimistic locking (version field) to prevent concurrent modification.
   * Validates that the new time slot is available before updating.
   * Sends reschedule notification email after success.
   * @param id - The UUID of the booking to reschedule
   * @param newStartTime - New start time in ISO 8601 format
   * @param userId - Optional user ID for ownership verification
   * @returns The updated booking
   * @throws Error if booking not found, cancelled, or new slot unavailable
   */
  async reschedule(
    id: string,
    newStartTime: string,
    userId?: string
  ): Promise<Booking> {
    const rescheduleLogger = logger.child({ operation: 'reschedule', bookingId: id });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get the existing booking with locking
      const existingResult = await client.query(
        `SELECT b.*, mt.duration_minutes, mt.buffer_before_minutes, mt.buffer_after_minutes,
                mt.name as meeting_type_name, mt.id as meeting_type_id,
                u.name as host_name, u.email as host_email
         FROM bookings b
         JOIN meeting_types mt ON b.meeting_type_id = mt.id
         JOIN users u ON b.host_user_id = u.id
         WHERE b.id = $1
         FOR UPDATE`,
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Booking not found');
      }

      const existing = existingResult.rows[0];

      if (userId && existing.host_user_id !== userId) {
        throw new Error('Unauthorized to reschedule this booking');
      }

      if (existing.status === 'cancelled') {
        throw new Error('Cannot reschedule a cancelled booking');
      }

      const startTime = parseISO(newStartTime);
      const endTime = addMinutes(startTime, existing.duration_minutes);
      const bufferStart = addMinutes(startTime, -existing.buffer_before_minutes);
      const bufferEnd = addMinutes(endTime, existing.buffer_after_minutes);

      // Check for conflicts (excluding the current booking)
      const conflicts = await client.query(
        `SELECT id FROM bookings
         WHERE host_user_id = $1
           AND id != $2
           AND status = 'confirmed'
           AND start_time < $3
           AND end_time > $4`,
        [existing.host_user_id, id, bufferEnd.toISOString(), bufferStart.toISOString()]
      );

      if (conflicts.rows.length > 0) {
        recordBookingOperation('reschedule', 'conflict');
        throw new Error('New time slot is not available');
      }

      // Update the booking
      const result = await client.query(
        `UPDATE bookings
         SET start_time = $1, end_time = $2, status = 'rescheduled',
             updated_at = NOW(), version = version + 1
         WHERE id = $3 AND version = $4
         RETURNING *`,
        [startTime.toISOString(), endTime.toISOString(), id, existing.version]
      );

      if (result.rows.length === 0) {
        throw new Error('Booking was modified by another request. Please try again.');
      }

      await client.query('COMMIT');

      const booking = result.rows[0];

      // Record success metric
      recordBookingOperation('reschedule', 'success');

      // Invalidate cache
      await this.invalidateAvailabilityCache(existing.host_user_id, existing.meeting_type_id);

      // Publish reschedule notification to RabbitMQ
      this.publishRescheduleNotification(booking, existing).catch((error) => {
        rescheduleLogger.error({ error }, 'Failed to publish reschedule notification');
      });

      // Send reschedule notification (legacy path)
      emailService.sendRescheduleNotification(booking).catch((error) => {
        rescheduleLogger.error({ error }, 'Failed to send reschedule notification');
        emailNotificationsTotal.inc({ type: 'reschedule', status: 'failure' });
      });

      rescheduleLogger.info({ newStartTime }, 'Booking rescheduled successfully');

      return booking;
    } catch (error) {
      await client.query('ROLLBACK');
      rescheduleLogger.error({ error }, 'Failed to reschedule booking');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Publishes reschedule notification to RabbitMQ.
   */
  private async publishRescheduleNotification(
    booking: Booking,
    meetingDetails: {
      meeting_type_name: string;
      meeting_type_id: string;
      host_name: string;
      host_email: string;
    }
  ): Promise<void> {
    await queueService.publishNotification('booking_rescheduled', {
      bookingId: booking.id,
      hostUserId: booking.host_user_id,
      inviteeEmail: booking.invitee_email,
      inviteeName: booking.invitee_name,
      meetingTypeName: meetingDetails.meeting_type_name,
      meetingTypeId: meetingDetails.meeting_type_id,
      hostName: meetingDetails.host_name,
      hostEmail: meetingDetails.host_email,
      startTime: booking.start_time.toString(),
      endTime: booking.end_time.toString(),
      inviteeTimezone: booking.invitee_timezone,
    });
  }

  /**
   * Cancels a booking.
   * Frees up the time slot for new bookings.
   * Sends cancellation notification email after success.
   * @param id - The UUID of the booking to cancel
   * @param reason - Optional cancellation reason for the notification
   * @param userId - Optional user ID for ownership verification
   * @returns The cancelled booking
   * @throws Error if booking not found or already cancelled
   */
  async cancel(id: string, reason?: string, userId?: string): Promise<Booking> {
    const cancelLogger = logger.child({ operation: 'cancel', bookingId: id });
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Get booking with lock and meeting type/host details
      const existingResult = await client.query(
        `SELECT b.*, mt.name as meeting_type_name, mt.id as meeting_type_id,
                u.name as host_name, u.email as host_email
         FROM bookings b
         JOIN meeting_types mt ON b.meeting_type_id = mt.id
         JOIN users u ON b.host_user_id = u.id
         WHERE b.id = $1
         FOR UPDATE`,
        [id]
      );

      if (existingResult.rows.length === 0) {
        throw new Error('Booking not found');
      }

      const existing = existingResult.rows[0];

      if (userId && existing.host_user_id !== userId) {
        throw new Error('Unauthorized to cancel this booking');
      }

      if (existing.status === 'cancelled') {
        throw new Error('Booking is already cancelled');
      }

      // Update the booking
      const result = await client.query(
        `UPDATE bookings
         SET status = 'cancelled', cancellation_reason = $1,
             updated_at = NOW(), version = version + 1
         WHERE id = $2
         RETURNING *`,
        [reason || null, id]
      );

      await client.query('COMMIT');

      const booking = result.rows[0];

      // Record success metric
      recordBookingOperation('cancel', 'success');

      // Invalidate cache
      await this.invalidateAvailabilityCache(existing.host_user_id, existing.meeting_type_id);

      // Update active bookings gauge
      await this.updateActiveBookingsGauge();

      // Publish cancellation notification to RabbitMQ
      this.publishCancellationNotification(booking, existing, reason).catch((error) => {
        cancelLogger.error({ error }, 'Failed to publish cancellation notification');
      });

      // Send cancellation notification (legacy path)
      emailService.sendCancellationNotification(booking, reason).catch((error) => {
        cancelLogger.error({ error }, 'Failed to send cancellation notification');
        emailNotificationsTotal.inc({ type: 'cancellation', status: 'failure' });
      });

      cancelLogger.info({ reason }, 'Booking cancelled successfully');

      return booking;
    } catch (error) {
      await client.query('ROLLBACK');
      cancelLogger.error({ error }, 'Failed to cancel booking');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Publishes cancellation notification to RabbitMQ.
   */
  private async publishCancellationNotification(
    booking: Booking,
    meetingDetails: {
      meeting_type_name: string;
      meeting_type_id: string;
      host_name: string;
      host_email: string;
    },
    reason?: string
  ): Promise<void> {
    await queueService.publishNotification('booking_cancelled', {
      bookingId: booking.id,
      hostUserId: booking.host_user_id,
      inviteeEmail: booking.invitee_email,
      inviteeName: booking.invitee_name,
      meetingTypeName: meetingDetails.meeting_type_name,
      meetingTypeId: meetingDetails.meeting_type_id,
      hostName: meetingDetails.host_name,
      hostEmail: meetingDetails.host_email,
      startTime: booking.start_time.toString(),
      endTime: booking.end_time.toString(),
      inviteeTimezone: booking.invitee_timezone,
      cancellationReason: reason,
    });
  }

  /**
   * Computes dashboard statistics for a host user.
   * Provides aggregated counts of bookings for display on the dashboard.
   * @param userId - The UUID of the host user
   * @returns Statistics including total, upcoming, and time-period counts
   */
  async getDashboardStats(userId: string): Promise<DashboardStats> {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const weekEnd = endOfWeek(now);
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);

    const [totalResult, upcomingResult, meetingTypesResult, weekResult, monthResult] =
      await Promise.all([
        pool.query(
          `SELECT COUNT(*) as count FROM bookings WHERE host_user_id = $1`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE host_user_id = $1 AND status = 'confirmed' AND start_time > NOW()`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) as count FROM meeting_types WHERE user_id = $1 AND is_active = true`,
          [userId]
        ),
        pool.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE host_user_id = $1 AND created_at >= $2 AND created_at <= $3`,
          [userId, weekStart.toISOString(), weekEnd.toISOString()]
        ),
        pool.query(
          `SELECT COUNT(*) as count FROM bookings
           WHERE host_user_id = $1 AND created_at >= $2 AND created_at <= $3`,
          [userId, monthStart.toISOString(), monthEnd.toISOString()]
        ),
      ]);

    return {
      total_bookings: parseInt(totalResult.rows[0].count),
      upcoming_bookings: parseInt(upcomingResult.rows[0].count),
      total_meeting_types: parseInt(meetingTypesResult.rows[0].count),
      bookings_this_week: parseInt(weekResult.rows[0].count),
      bookings_this_month: parseInt(monthResult.rows[0].count),
    };
  }

  /**
   * Updates the active bookings Prometheus gauge.
   * Called after booking creation or cancellation.
   */
  private async updateActiveBookingsGauge(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM bookings
         WHERE status = 'confirmed' AND start_time > NOW()`
      );
      activeBookingsGauge.set(parseInt(result.rows[0].count));
    } catch (error) {
      logger.error({ error }, 'Failed to update active bookings gauge');
    }
  }

  /**
   * Sends confirmation emails to both invitee and host.
   * Called asynchronously after booking creation.
   * @param booking - The newly created booking
   * @param meetingType - Meeting type details for email content
   */
  private async sendConfirmationEmails(
    booking: Booking,
    meetingType: { name: string; user_name: string; user_email: string }
  ): Promise<void> {
    // Send to invitee
    await emailService.sendBookingConfirmation(booking, meetingType, 'invitee');
    emailNotificationsTotal.inc({ type: 'confirmation', status: 'success' });

    // Send to host
    await emailService.sendBookingConfirmation(booking, meetingType, 'host');
    emailNotificationsTotal.inc({ type: 'confirmation', status: 'success' });
  }

  /**
   * Clears cached availability slots when bookings change.
   * Ensures invitees see up-to-date availability.
   * @param userId - The UUID of the host user
   * @param meetingTypeId - The UUID of the affected meeting type
   */
  private async invalidateAvailabilityCache(
    userId: string,
    meetingTypeId: string
  ): Promise<void> {
    const keys = await redis.keys(`slots:${meetingTypeId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }
}

/** Singleton instance of BookingService for application-wide use */
export const bookingService = new BookingService();
