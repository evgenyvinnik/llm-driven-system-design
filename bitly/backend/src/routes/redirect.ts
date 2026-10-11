import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { resolveShortCode } from '../services/urlService.js';
import { dispatchClickEvent } from '../services/analyticsService.js';
import { ClickEventMessage } from '../models/types.js';
import logger from '../utils/logger.js';
import { urlRedirectsTotal } from '../utils/metrics.js';

/**
 * Redirect router.
 * Handles the core URL shortening functionality - redirecting short URLs to destinations.
 * Mounted at the root path to catch /:shortCode requests.
 */
const router = Router();

/**
 * Responses on this route must not be stored by shared caches (a CDN would serve a
 * deactivated link, or a stale 404 for a code created later) and should not be reused
 * by browsers either: every click has to reach us to be counted.
 */
const REDIRECT_CACHE_CONTROL = 'private, no-store';

/**
 * GET /:shortCode - Redirect to the original long URL
 * Uses 302 (temporary) redirect to ensure analytics are captured.
 * Records click events after the response via RabbitMQ (with a direct-insert fallback).
 */
router.get(
  '/:shortCode',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;
    const startTime = Date.now();

    const result = await resolveShortCode(shortCode);
    // 'skipped': the code is syntactically impossible and never reached a cache.
    const cached = result.source === 'database' ? 'miss' : result.source === 'cache' ? 'hit' : 'skipped';

    res.set('Cache-Control', REDIRECT_CACHE_CONTROL);

    if (!result.found) {
      urlRedirectsTotal.inc({ cached, status: 'not_found' });
      logger.info({ short_code: shortCode, source: result.source }, 'Redirect failed - URL not found');
      res.status(404).json({ error: 'Short URL not found or has expired' });
      return;
    }

    // Increment redirect metric
    urlRedirectsTotal.inc({ cached, status: 'success' });

    // Parse device type for metrics and analytics
    const userAgent = req.get('User-Agent');

    // The event_id is the idempotency key for the whole analytics pipeline.
    const clickEvent: ClickEventMessage = {
      event_id: crypto.randomUUID(),
      short_code: shortCode,
      referrer: req.get('Referer'),
      user_agent: userAgent,
      ip_address: req.ip,
      device_type: parseDeviceType(userAgent),
      timestamp: new Date().toISOString(),
    };

    logger.info(
      {
        short_code: shortCode,
        cache_hit: result.source === 'cache',
        duration_ms: Date.now() - startTime,
      },
      'Redirect successful'
    );

    // Use 302 (temporary) redirect to ensure analytics tracking
    // 301 would be cached by browsers and we'd miss analytics
    res.redirect(302, result.longUrl);

    // Record the click only after the response is on its way: publishing (and any
    // fallback insert) never adds latency to the redirect.
    dispatchClickEvent(clickEvent);
  })
);

/**
 * Parses a User-Agent string to determine device type.
 * @param userAgent - The User-Agent header value
 * @returns Device type: 'mobile', 'tablet', 'desktop', 'bot', or 'unknown'
 */
function parseDeviceType(userAgent: string | undefined): string {
  if (!userAgent) return 'unknown';

  const ua = userAgent.toLowerCase();

  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    return 'mobile';
  }
  if (ua.includes('tablet') || ua.includes('ipad')) {
    return 'tablet';
  }
  if (ua.includes('bot') || ua.includes('crawler') || ua.includes('spider')) {
    return 'bot';
  }
  return 'desktop';
}

export default router;
