import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { logger } from '../services/logger.js';
import { recordView, getVideoAnalytics } from '../services/analyticsService.js';
import { resolveVideoAccess, requireVideoAccess, isUuid } from '../services/videoAccess.js';
import { viewEvents } from '../services/metrics.js';

const router = Router();

const MAX_WATCH_SECONDS = 24 * 60 * 60;

// POST /api/analytics/view - Start a view or send a heartbeat for one (same viewId)
router.post('/view', async (req: Request, res: Response) => {
  try {
    const { videoId, viewId, sessionId, watchDurationSeconds = 0, completed = false } = req.body ?? {};

    if (!isUuid(videoId) || !isUuid(viewId)) {
      res.status(400).json({ error: 'videoId and viewId must be UUIDs' });
      return;
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 64) {
      res.status(400).json({ error: 'sessionId must be a string of 1-64 characters' });
      return;
    }
    if (
      typeof watchDurationSeconds !== 'number' ||
      !Number.isFinite(watchDurationSeconds) ||
      watchDurationSeconds < 0 ||
      watchDurationSeconds > MAX_WATCH_SECONDS
    ) {
      res.status(400).json({ error: 'watchDurationSeconds must be between 0 and 86400' });
      return;
    }
    if (typeof completed !== 'boolean') {
      res.status(400).json({ error: 'completed must be a boolean' });
      return;
    }

    // Only people who can watch the video can count a view of it.
    const access = await resolveVideoAccess(req, videoId);
    if (!access) {
      res.status(404).json({ error: 'Video not found' });
      return;
    }
    // Creators re-watching their own recording are not audience.
    if (access.role === 'owner') {
      viewEvents.inc({ result: 'owner_ignored' });
      res.json({ recorded: false });
      return;
    }

    const result = await recordView({
      viewId,
      videoId,
      viewerId: req.session?.userId || null,
      sessionId,
      watchDurationSeconds,
      completed,
      ipAddress: req.ip || '',
      userAgent: req.headers['user-agent'] || '',
    });
    viewEvents.inc({ result });
    res.json({ recorded: result !== 'ignored', newView: result === 'new' });
  } catch (err) {
    logger.error({ err }, 'Failed to record view');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/:videoId/analytics - Aggregated analytics (owner only)
router.get(
  '/:videoId/analytics',
  requireAuth,
  requireVideoAccess('owner'),
  async (req: Request, res: Response) => {
    try {
      const requested = parseInt(req.query.days as string, 10);
      const days = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 365) : 30;

      const analytics = await getVideoAnalytics(req.params.videoId, days);

      res.json({ analytics });
    } catch (err) {
      logger.error({ err }, 'Failed to get analytics');
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

export default router;
