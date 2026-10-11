import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { getUrlAnalytics, getRecentClicks } from '../services/analyticsService.js';
import { getUrlOwner, canAccessUrl } from '../services/urlService.js';
import logger from '../utils/logger.js';

/**
 * Analytics router.
 * Provides endpoints for viewing URL click analytics.
 * All routes require authentication, and per-link data is visible only to the link's
 * owner or an admin (raw click rows include IP addresses and user agents).
 */
const router = Router();

/**
 * Authorizes access to one link's analytics: 404 if the code does not exist, 403 unless
 * the caller owns the link or is an admin.
 */
async function authorizeLinkAnalytics(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { shortCode } = req.params;
  const owner = await getUrlOwner(shortCode);

  if (!owner) {
    res.status(404).json({ error: 'URL not found' });
    return;
  }

  if (!canAccessUrl(owner.user_id, req.user)) {
    logger.warn({ short_code: shortCode, user_id: req.user?.id }, 'Analytics access denied');
    res.status(403).json({ error: 'You do not have access to analytics for this URL' });
    return;
  }

  next();
}

/**
 * GET /:shortCode - Get aggregated analytics for a URL
 * Returns total clicks, daily trends, top referrers, and device breakdown.
 */
router.get(
  '/:shortCode',
  requireAuth,
  asyncHandler(authorizeLinkAnalytics),
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

/**
 * GET /:shortCode/clicks - Get recent individual click events
 * Returns detailed click-level data for analysis.
 * Supports limit parameter (1-1000, default 100).
 */
router.get(
  '/:shortCode/clicks',
  requireAuth,
  asyncHandler(authorizeLinkAnalytics),
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 1000);

    const clicks = await getRecentClicks(shortCode, limit);

    res.json({ clicks });
  })
);

export default router;
