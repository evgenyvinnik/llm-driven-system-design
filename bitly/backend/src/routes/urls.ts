import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import {
  createUrl,
  getUrlDetails,
  getUserUrls,
  updateUrl,
  deleteUrl,
} from '../services/urlService.js';
import { createUrlLimiter } from '../middleware/rateLimit.js';
import { idempotencyMiddleware } from '../utils/idempotency.js';
import { HttpError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { urlShorteningTotal } from '../utils/metrics.js';

/**
 * URL management router.
 * Provides CRUD operations for shortened URLs.
 * Routes: POST /, GET /, GET /:shortCode, PATCH /:shortCode, DELETE /:shortCode
 */
const router = Router();

/**
 * POST / - Create a new shortened URL
 * Accepts long_url, optional custom_code, and optional expires_in.
 * Optionally associates URL with authenticated user.
 * Middleware order: creation rate limit, then authentication (the idempotency key is
 * scoped by user), then Idempotency-Key handling, then the handler.
 */
router.post(
  '/',
  createUrlLimiter,
  optionalAuth,
  idempotencyMiddleware,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { long_url, custom_code, expires_in } = req.body ?? {};

    if (!long_url) {
      urlShorteningTotal.inc({ status: 'error' });
      res.status(400).json({ error: 'long_url is required' });
      return;
    }

    try {
      const url = await createUrl({
        long_url,
        custom_code,
        expires_in,
        user_id: req.user?.id,
      });

      urlShorteningTotal.inc({ status: 'success' });
      logger.info(
        {
          short_code: url.short_code,
          user_id: req.user?.id,
          is_custom: url.is_custom,
        },
        'URL created successfully'
      );

      res.status(201).json(url);
    } catch (error) {
      // Track different error types
      urlShorteningTotal.inc({ status: error instanceof HttpError && error.status === 409 ? 'duplicate' : 'error' });

      if (error instanceof HttpError) {
        logger.warn({ err: error, long_url: String(long_url).substring(0, 100) }, 'URL creation rejected');
        res.status(error.status).json({ error: error.message });
        return;
      }
      // Infrastructure failures are 500s, not client errors.
      throw error;
    }
  })
);

/**
 * GET / - List authenticated user's URLs
 * Supports pagination via limit and offset query parameters.
 * Requires authentication.
 */
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    const result = await getUserUrls(req.user!.id, limit, offset);

    res.json(result);
  })
);

/**
 * GET /:shortCode - Get URL details
 * Returns full URL information for display.
 * Filters by user ID if authenticated.
 */
router.get(
  '/:shortCode',
  optionalAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;

    const url = await getUrlDetails(shortCode, req.user?.id);

    if (!url) {
      res.status(404).json({ error: 'URL not found' });
      return;
    }

    res.json(url);
  })
);

/**
 * PATCH /:shortCode - Update URL properties
 * Allows updating is_active and expires_at (null clears the expiration).
 * Requires authentication and URL ownership.
 */
router.patch(
  '/:shortCode',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;
    const { is_active, expires_at } = req.body ?? {};

    if (is_active !== undefined && typeof is_active !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }

    let expiresAt: Date | null | undefined;
    if (expires_at === null) {
      expiresAt = null;
    } else if (expires_at !== undefined) {
      expiresAt = new Date(expires_at);
      if (typeof expires_at !== 'string' || Number.isNaN(expiresAt.getTime())) {
        res.status(400).json({ error: 'expires_at must be an ISO-8601 timestamp or null' });
        return;
      }
    }

    const url = await updateUrl(shortCode, req.user!.id, {
      is_active,
      expires_at: expiresAt,
    });

    if (!url) {
      res.status(404).json({ error: 'URL not found or not owned by you' });
      return;
    }

    logger.info({ short_code: shortCode, user_id: req.user!.id }, 'URL updated');
    res.json(url);
  })
);

/**
 * DELETE /:shortCode - Soft-delete a URL
 * Marks the URL as inactive (soft delete).
 * Requires authentication and URL ownership.
 */
router.delete(
  '/:shortCode',
  requireAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;

    const deleted = await deleteUrl(shortCode, req.user!.id);

    if (!deleted) {
      res.status(404).json({ error: 'URL not found or not owned by you' });
      return;
    }

    logger.info({ short_code: shortCode, user_id: req.user!.id }, 'URL deleted');
    res.status(204).send();
  })
);

export default router;
