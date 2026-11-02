import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import * as labelService from '../services/labelService.js';
import { invalidateMailboxes } from '../services/redis.js';
import { isUuid } from '../services/validation.js';
import logger from '../services/logger.js';

const router = Router();

/**
 * GET /api/v1/labels
 * List all labels for the current user
 */
router.get('/', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const labels = await labelService.listLabels(userId);
    res.json({ labels });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to list labels');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/labels
 * Create a custom label
 */
router.post('/', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Label name is required' });
    }

    const label = await labelService.createLabel(userId, name, color);
    res.status(201).json({ label });
  } catch (error) {
    const err = error as Error;
    if (err.message.includes('duplicate key') || err.message.includes('unique constraint')) {
      return res.status(409).json({ error: 'Label already exists' });
    }
    logger.error({ error: err.message }, 'Failed to create label');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/v1/labels/:labelId
 * Update a custom label
 */
router.put('/:labelId', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { labelId } = req.params;
    const { name, color } = req.body;

    const label = await labelService.updateLabel(userId, labelId, name, color);
    // Cached thread lists embed label names.
    await invalidateMailboxes(userId);
    if (!label) {
      return res.status(404).json({ error: 'Label not found or is a system label' });
    }

    res.json({ label });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to update label');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/v1/labels/:labelId
 * Delete a custom label
 */
router.delete('/:labelId', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { labelId } = req.params;

    const deleted = await labelService.deleteLabel(userId, labelId);
    await invalidateMailboxes(userId);
    if (!deleted) {
      return res.status(404).json({ error: 'Label not found or is a system label' });
    }

    res.json({ message: 'Label deleted' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to delete label');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/labels/:labelId/assign
 * Assign a label to a thread
 */
router.post('/:labelId/assign', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { labelId } = req.params;
    const { threadId } = req.body;

    if (!isUuid(threadId) || !isUuid(labelId)) {
      return res.status(isUuid(threadId) || !threadId ? 400 : 404).json({ error: 'A valid thread ID and label ID are required' });
    }

    const assigned = await labelService.assignLabel(userId, threadId, labelId);
    if (!assigned) {
      return res.status(404).json({ error: 'Label or thread not found' });
    }
    await invalidateMailboxes(userId);

    res.json({ message: 'Label assigned' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to assign label');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/v1/labels/:labelId/remove
 * Remove a label from a thread
 */
router.post('/:labelId/remove', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { labelId } = req.params;
    const { threadId } = req.body;

    if (!threadId) {
      return res.status(400).json({ error: 'Thread ID is required' });
    }

    await labelService.removeLabel(userId, threadId, labelId);
    await invalidateMailboxes(userId);

    res.json({ message: 'Label removed' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to remove label');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
