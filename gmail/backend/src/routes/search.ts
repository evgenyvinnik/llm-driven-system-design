import { Router, Request, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth.js';
import { search } from '../services/searchService.js';
import { searchRateLimiter } from '../services/rateLimiter.js';
import logger from '../services/logger.js';

const router = Router();

/**
 * GET /api/v1/search?q=query&page=1
 * Search emails with advanced operators (from:, to:, has:attachment, before:, after:)
 */
router.get(
  '/',
  requireAuth as unknown as import('express').RequestHandler,
  searchRateLimiter,
  async (req: Request, res: Response) => {
    try {
      const authReq = req as AuthenticatedRequest;
      const userId = authReq.session.userId!;
      const q = (req.query.q as string) || '';
      const page = parseInt(req.query.page as string) || 1;

      if (!q.trim()) {
        return res.status(400).json({ error: 'Search query is required' });
      }

      const result = await search(userId, q, page);

      res.json({
        results: result.results,
        total: result.total,
        page,
        // True when Elasticsearch was unavailable and results came from SQL.
        degraded: result.degraded,
      });
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Search failed');
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

export default router;
