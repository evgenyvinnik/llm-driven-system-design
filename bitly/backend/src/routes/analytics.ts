import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { getUrlAnalytics, getRecentClicks } from '../services/analyticsService.js';

const router = Router();

// Get analytics for a URL
router.get(
  '/:shortCode',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;

    const analytics = await getUrlAnalytics(shortCode);

    if (!analytics) {
      res.status(404).json({ error: 'URL not found' });
      return;
    }

    res.json(analytics);
  })
);

// Get recent clicks for a URL
router.get(
  '/:shortCode/clicks',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;
    const limit = parseInt(req.query.limit as string, 10) || 100;

    const clicks = await getRecentClicks(shortCode, limit);

    res.json({ clicks });
  })
);

export default router;
