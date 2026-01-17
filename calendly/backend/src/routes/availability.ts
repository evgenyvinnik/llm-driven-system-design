import { Router, Request, Response } from 'express';
import { availabilityService } from '../services/availabilityService.js';
import { requireAuth } from '../middleware/auth.js';
import { BulkAvailabilitySchema, AvailabilitySlotsQuerySchema } from '../types/index.js';
import { isValidTimezone } from '../utils/time.js';
import { z } from 'zod';

const router = Router();

/**
 * GET /api/availability/rules - Get availability rules for the current user
 */
router.get('/rules', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const rules = await availabilityService.getRules(userId);

    res.json({
      success: true,
      data: rules,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get availability rules',
    });
  }
});

/**
 * POST /api/availability/rules - Set availability rules (bulk update)
 */
router.post('/rules', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const input = BulkAvailabilitySchema.parse(req.body);

    const rules = await availabilityService.setRules(userId, input.rules);

    res.json({
      success: true,
      data: rules,
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

    res.status(500).json({
      success: false,
      error: 'Failed to set availability rules',
    });
  }
});

/**
 * DELETE /api/availability/rules/:id - Delete an availability rule
 */
router.delete('/rules/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const deleted = await availabilityService.deleteRule(req.params.id, userId);

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Availability rule not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Availability rule deleted',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete availability rule',
    });
  }
});

/**
 * GET /api/availability/slots - Get available time slots for a meeting type
 */
router.get('/slots', async (req: Request, res: Response) => {
  try {
    const query = AvailabilitySlotsQuerySchema.parse(req.query);

    // Validate timezone
    if (!isValidTimezone(query.timezone)) {
      res.status(400).json({
        success: false,
        error: 'Invalid timezone',
      });
      return;
    }

    const slots = await availabilityService.getAvailableSlots(
      query.meeting_type_id,
      query.date,
      query.timezone
    );

    res.json({
      success: true,
      data: {
        date: query.date,
        timezone: query.timezone,
        slots,
      },
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
      error: error instanceof Error ? error.message : 'Failed to get available slots',
    });
  }
});

/**
 * GET /api/availability/dates - Get dates with available slots
 */
router.get('/dates', async (req: Request, res: Response) => {
  try {
    const meetingTypeId = req.query.meeting_type_id as string;
    const timezone = (req.query.timezone as string) || 'UTC';
    const daysAhead = parseInt((req.query.days_ahead as string) || '30');

    if (!meetingTypeId) {
      res.status(400).json({
        success: false,
        error: 'meeting_type_id is required',
      });
      return;
    }

    if (!isValidTimezone(timezone)) {
      res.status(400).json({
        success: false,
        error: 'Invalid timezone',
      });
      return;
    }

    const dates = await availabilityService.getAvailableDates(
      meetingTypeId,
      timezone,
      daysAhead
    );

    res.json({
      success: true,
      data: {
        meeting_type_id: meetingTypeId,
        timezone,
        available_dates: dates,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get available dates',
    });
  }
});

export default router;
