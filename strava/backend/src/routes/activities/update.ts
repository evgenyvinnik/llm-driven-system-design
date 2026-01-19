import { Router, Response } from 'express';
import { query } from '../../utils/db.js';
import { requireAuth, AuthenticatedRequest } from '../../middleware/auth.js';
import { activityLogger as log, logError, ErrorWithCode } from '../../shared/logger.js';

const router = Router();

// Give kudos to an activity
router.post('/:id/kudos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    await query(
      'INSERT INTO kudos (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, userId]
    );

    await query(
      'UPDATE activities SET kudos_count = (SELECT COUNT(*) FROM kudos WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.json({ message: 'Kudos given' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Kudos error');
    res.status(500).json({ error: 'Failed to give kudos' });
  }
});

// Remove kudos from an activity
router.delete('/:id/kudos', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    await query(
      'DELETE FROM kudos WHERE activity_id = $1 AND user_id = $2',
      [id, userId]
    );

    await query(
      'UPDATE activities SET kudos_count = (SELECT COUNT(*) FROM kudos WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.json({ message: 'Kudos removed' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Remove kudos error');
    res.status(500).json({ error: 'Failed to remove kudos' });
  }
});

// Add comment to an activity
router.post('/:id/comments', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;
    const { content } = req.body as { content?: string };

    if (!content || content.trim().length === 0) {
      res.status(400).json({ error: 'Comment content is required' });
      return;
    }

    const result = await query<{ id: string; content: string; created_at: Date }>(
      `INSERT INTO comments (activity_id, user_id, content) VALUES ($1, $2, $3)
       RETURNING id, content, created_at`,
      [id, userId, content.trim()]
    );

    await query(
      'UPDATE activities SET comment_count = (SELECT COUNT(*) FROM comments WHERE activity_id = $1) WHERE id = $1',
      [id]
    );

    res.status(201).json({ comment: result.rows[0] });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Add comment error');
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Delete activity (owner only)
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.session.userId!;

    const result = await query<{ id: string }>(
      'DELETE FROM activities WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Activity not found or not owned by you' });
      return;
    }

    log.info({ activityId: id, userId }, 'Activity deleted');
    res.json({ message: 'Activity deleted' });
  } catch (error) {
    logError(log, error as ErrorWithCode, 'Delete activity error');
    res.status(500).json({ error: 'Failed to delete activity' });
  }
});

export default router;
