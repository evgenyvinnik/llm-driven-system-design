import { Router, Request, Response } from 'express';
import { bookingService } from '../services/bookingService.js';
import { requireAuth } from '../middleware/auth.js';
import {
  CreateBookingSchema,
  RescheduleBookingSchema,
  CancelBookingSchema,
} from '../types/index.js';
import { isValidTimezone } from '../utils/time.js';
import { IDEMPOTENCY_CONFIG } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { z } from 'zod';

/**
 * Express router for booking management.
 * Handles booking creation, retrieval, rescheduling, and cancellation.
 *
 * IDEMPOTENCY:
 * The POST /api/bookings endpoint supports idempotent requests via the
 * X-Idempotency-Key header. When provided, duplicate requests with the
 * same key will return the cached result from the first request.
 */
const router = Router();

/**
 * GET /api/bookings - Get bookings for the current user.
 * Requires authentication.
 * @query {status} - Optional filter by status (confirmed, cancelled, rescheduled)
 * @query {upcoming} - If 'true', only return future bookings
 * @returns {Booking[]} Array of bookings with details
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const status = req.query.status as string | undefined;
    const upcoming = req.query.upcoming === 'true';

    const bookings = await bookingService.getBookingsForUser(userId, status, upcoming);

    res.json({
      success: true,
      data: bookings,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get bookings',
    });
  }
});

/**
 * GET /api/bookings/stats - Get dashboard statistics for the current user.
 * Requires authentication.
 * @returns {DashboardStats} Aggregated booking statistics
 */
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const stats = await bookingService.getDashboardStats(userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get statistics',
    });
  }
});

/**
 * GET /api/bookings/:id - Get a specific booking with details.
 * Public endpoint for confirmation pages.
 * @param {id} - Booking UUID
 * @returns {Booking} Booking with meeting type and host details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const booking = await bookingService.findByIdWithDetails(req.params.id);

    if (!booking) {
      res.status(404).json({
        success: false,
        error: 'Booking not found',
      });
      return;
    }

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get booking',
    });
  }
});

/**
 * POST /api/bookings - Create a new booking.
 * Public endpoint for invitees. Implements double-booking prevention.
 * Sends confirmation emails on success.
 *
 * IDEMPOTENCY:
 * Include the X-Idempotency-Key header to ensure idempotent behavior.
 * If the same key is used for multiple requests, only the first request
 * will create a booking. Subsequent requests will return the cached result.
 *
 * Even without the header, the system generates an automatic idempotency
 * key based on meeting_type_id + start_time + invitee_email to prevent
 * accidental duplicates.
 *
 * @header {X-Idempotency-Key} - Optional idempotency key (recommended)
 * @body {meeting_type_id, start_time, invitee_name, invitee_email, invitee_timezone, notes}
 * @returns {Booking} The newly created booking
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const input = CreateBookingSchema.parse(req.body);

    // Validate timezone
    if (!isValidTimezone(input.invitee_timezone)) {
      res.status(400).json({
        success: false,
        error: 'Invalid timezone',
      });
      return;
    }

    // Extract idempotency key from header
    const idempotencyKey = req.headers[IDEMPOTENCY_CONFIG.HEADER_NAME.toLowerCase()] as
      | string
      | undefined;

    // Create booking with idempotency support
    const result = await bookingService.createBooking(input, idempotencyKey);

    // If result was cached (idempotent replay), still return 201
    // but log that it was a duplicate request
    if (result.cached) {
      logger.info(
        {
          bookingId: result.booking.id,
          idempotencyKey,
        },
        'Returned cached booking result (idempotent replay)'
      );
    }

    res.status(201).json({
      success: true,
      data: result.booking,
      cached: result.cached,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create booking',
    });
  }
});

/**
 * PUT /api/bookings/:id/reschedule - Reschedule an existing booking.
 * Can be called by authenticated hosts or invitees via booking link.
 * Validates new slot availability.
 * @param {id} - Booking UUID
 * @body {new_start_time} - New start time in ISO 8601 format
 * @returns {Booking} The updated booking
 */
router.put('/:id/reschedule', async (req: Request, res: Response) => {
  try {
    const input = RescheduleBookingSchema.parse(req.body);

    // If user is authenticated, verify ownership
    const userId = req.session?.userId;

    const booking = await bookingService.reschedule(req.params.id, input.new_start_time, userId);

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reschedule booking',
    });
  }
});

/**
 * DELETE /api/bookings/:id - Cancel a booking.
 * Can be called by authenticated hosts or invitees via booking link.
 * Frees up the time slot for new bookings.
 * @param {id} - Booking UUID
 * @body {reason} - Optional cancellation reason
 * @returns {Booking} The cancelled booking
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const input = req.body ? CancelBookingSchema.parse(req.body) : { reason: undefined };

    // If user is authenticated, verify ownership
    const userId = req.session?.userId;

    const booking = await bookingService.cancel(req.params.id, input.reason, userId);

    res.json({
      success: true,
      data: booking,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel booking',
    });
  }
});

export default router;
