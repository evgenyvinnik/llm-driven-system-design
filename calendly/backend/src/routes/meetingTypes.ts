import { Router, Request, Response } from 'express';
import { meetingTypeService } from '../services/meetingTypeService.js';
import { requireAuth } from '../middleware/auth.js';
import { CreateMeetingTypeSchema, UpdateMeetingTypeSchema } from '../types/index.js';
import { z } from 'zod';

/**
 * Express router for meeting type (event type) management.
 * Meeting types define the scheduling options hosts offer to invitees.
 */
const router = Router();

/**
 * GET /api/meeting-types - Get all meeting types for the current user.
 * Requires authentication.
 * @query {active} - If 'true', only return active meeting types
 * @returns {MeetingType[]} Array of meeting types
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const activeOnly = req.query.active === 'true';
    const meetingTypes = await meetingTypeService.findByUserId(userId, activeOnly);

    res.json({
      success: true,
      data: meetingTypes,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get meeting types',
    });
  }
});

/**
 * GET /api/meeting-types/:id - Get a specific meeting type with host info.
 * Public endpoint for booking pages. Only returns active meeting types.
 * @param {id} - Meeting type UUID
 * @returns {MeetingType} Meeting type with user details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const meetingType = await meetingTypeService.findByIdWithUser(req.params.id);

    if (!meetingType) {
      res.status(404).json({
        success: false,
        error: 'Meeting type not found',
      });
      return;
    }

    res.json({
      success: true,
      data: meetingType,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to get meeting type',
    });
  }
});

/**
 * POST /api/meeting-types - Create a new meeting type.
 * Requires authentication. Validates slug uniqueness per user.
 * @body {name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, max_bookings_per_day, color}
 * @returns {MeetingType} The newly created meeting type
 */
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const input = CreateMeetingTypeSchema.parse(req.body);

    // Check if slug is unique for this user
    const existing = await meetingTypeService.findBySlug(userId, input.slug);
    if (existing) {
      res.status(400).json({
        success: false,
        error: 'A meeting type with this slug already exists',
      });
      return;
    }

    const meetingType = await meetingTypeService.create(userId, input);

    res.status(201).json({
      success: true,
      data: meetingType,
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
      error: 'Failed to create meeting type',
    });
  }
});

/**
 * PUT /api/meeting-types/:id - Update an existing meeting type.
 * Requires authentication and ownership. Validates slug uniqueness if changed.
 * @param {id} - Meeting type UUID
 * @body Partial meeting type fields to update
 * @returns {MeetingType} The updated meeting type
 */
router.put('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const updates = UpdateMeetingTypeSchema.parse(req.body);

    // If updating slug, check uniqueness
    if (updates.slug) {
      const existing = await meetingTypeService.findBySlug(userId, updates.slug);
      if (existing && existing.id !== req.params.id) {
        res.status(400).json({
          success: false,
          error: 'A meeting type with this slug already exists',
        });
        return;
      }
    }

    const meetingType = await meetingTypeService.update(req.params.id, userId, updates);

    if (!meetingType) {
      res.status(404).json({
        success: false,
        error: 'Meeting type not found',
      });
      return;
    }

    res.json({
      success: true,
      data: meetingType,
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
      error: 'Failed to update meeting type',
    });
  }
});

/**
 * DELETE /api/meeting-types/:id - Delete a meeting type.
 * Requires authentication and ownership. Permanently removes the meeting type.
 * @param {id} - Meeting type UUID
 * @returns {message} Success message
 */
router.delete('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const deleted = await meetingTypeService.delete(req.params.id, userId);

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Meeting type not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Meeting type deleted',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Failed to delete meeting type',
    });
  }
});

export default router;
