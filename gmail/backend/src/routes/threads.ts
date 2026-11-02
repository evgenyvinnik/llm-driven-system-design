import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import * as threadService from '../services/threadService.js';
import logger from '../services/logger.js';
import { isUuid } from '../services/validation.js';

const router = Router();

/**
 * GET /api/v1/threads?label=INBOX&page=1
 * List threads filtered by label
 */
router.get('/', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const labelName = (req.query.label as string) || 'INBOX';
    const page = parseInt(req.query.page as string) || 1;

    const result = await threadService.listThreads(userId, labelName, page);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to list threads');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/threads/unread-counts
 * Get unread counts for all labels
 */
router.get('/unread-counts', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;

    const counts = await threadService.getUnreadCounts(userId);
    res.json({ counts: Object.fromEntries(counts) });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get unread counts');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/v1/threads/:threadId
 * Get a single thread with all messages
 */
router.get('/:threadId', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { threadId } = req.params;
    if (!isUuid(threadId)) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const thread = await threadService.getThread(userId, threadId);
    if (!thread) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    // Auto-mark as read when opening
    if (!thread.isRead) {
      await threadService.updateThreadState(userId, threadId, { isRead: true });
      thread.isRead = true;
    }

    res.json({ thread });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to get thread');
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/v1/threads/:threadId/state
 * Update thread state (read, starred, archived, trashed, spam)
 */
router.patch('/:threadId/state', requireAuth as unknown as import('express').RequestHandler, async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const userId = authReq.session.userId!;
    const { threadId } = req.params;
    const { isRead, isStarred, isArchived, isTrashed, isSpam } = req.body;
    if (!isUuid(threadId)) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    const updated = await threadService.updateThreadState(userId, threadId, {
      isRead,
      isStarred,
      isArchived,
      isTrashed,
      isSpam,
    });
    if (!updated) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    res.json({ message: 'Thread state updated' });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to update thread state');
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
