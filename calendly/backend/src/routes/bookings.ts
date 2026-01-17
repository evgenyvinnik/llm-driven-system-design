import { Router, Request, Response } from 'express';
import { bookingService } from '../services/bookingService.js';
import { requireAuth } from '../middleware/auth.js';
import {
  CreateBookingSchema,
  RescheduleBookingSchema,
  CancelBookingSchema,
} from '../types/index.js';
import { isValidTimezone } from '../utils/time.js';
import { z } from 'zod';

const router = Router();

/**
 * GET /api/bookings - Get bookings for the current user
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
 * GET /api/bookings/stats - Get dashboard statistics
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
 * GET /api/bookings/:id - Get a specific booking
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
 * POST /api/bookings - Create a new booking
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

    const booking = await bookingService.createBooking(input);

    res.status(201).json({
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
      error: error instanceof Error ? error.message : 'Failed to create booking',
    });
  }
});

/**
 * PUT /api/bookings/:id/reschedule - Reschedule a booking
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
 * DELETE /api/bookings/:id - Cancel a booking
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
