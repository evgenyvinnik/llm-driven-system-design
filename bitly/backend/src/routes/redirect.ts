import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { getUrlByShortCode } from '../services/urlService.js';
import { publishClickEvent, isQueueConnected, ClickEventMessage } from '../utils/queue.js';
import { recordClickSync } from '../services/analyticsService.js';
import logger from '../utils/logger.js';
import { urlRedirectsTotal, clickEventsTotal } from '../utils/metrics.js';

/**
 * Redirect router.
 * Handles the core URL shortening functionality - redirecting short URLs to destinations.
 * Mounted at the root path to catch /:shortCode requests.
 */
const router = Router();

/**
 * GET /:shortCode - Redirect to the original long URL
 * Uses 302 (temporary) redirect to ensure analytics are captured.
 * Records click events asynchronously via RabbitMQ to avoid blocking the redirect.
 */
router.get(
  '/:shortCode',
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const { shortCode } = req.params;
    const startTime = Date.now();

    // Track whether this was a cache hit (set by urlService)
    const result = await getUrlByShortCodeWithCacheInfo(shortCode);

    if (!result) {
      urlRedirectsTotal.inc({ cached: 'miss', status: 'not_found' });
      logger.info({ short_code: shortCode }, 'Redirect failed - URL not found');
      res.status(404).json({ error: 'Short URL not found or has expired' });
      return;
    }

    const { longUrl, cacheHit } = result;

    // Increment redirect metric
    urlRedirectsTotal.inc({ cached: cacheHit ? 'hit' : 'miss', status: 'success' });

    // Parse device type for metrics and analytics
    const userAgent = req.get('User-Agent');
    const deviceType = parseDeviceType(userAgent);

    // Build click event data
    const clickEvent: ClickEventMessage = {
      short_code: shortCode,
      referrer: req.get('Referer'),
      user_agent: userAgent,
      ip_address: req.ip,
      device_type: deviceType,
      timestamp: new Date().toISOString(),
    };

    // Record click asynchronously via queue (non-blocking)
    // If queue is unavailable, fall back to direct database insert
    setImmediate(async () => {
      try {
        if (isQueueConnected()) {
          // Publish to queue for async processing by worker
          await publishClickEvent(clickEvent);
        } else {
          // Fallback: sync insert if queue unavailable
          logger.warn({ short_code: shortCode }, 'Queue unavailable, using sync recording');
          await recordClickSync(clickEvent);
        }

        // Track click event by device type
        clickEventsTotal.inc({ device_type: deviceType });

        logger.debug(
          {
            short_code: shortCode,
            device_type: deviceType,
            referrer: req.get('Referer'),
            duration_ms: Date.now() - startTime,
            queue_available: isQueueConnected(),
          },
          'Click event recorded'
        );
      } catch (error) {
        logger.error({ err: error, short_code: shortCode }, 'Failed to record click');
      }
    });

    logger.info(
      {
        short_code: shortCode,
        cache_hit: cacheHit,
        duration_ms: Date.now() - startTime,
      },
      'Redirect successful'
    );

    // Use 302 (temporary) redirect to ensure analytics tracking
    // 301 would be cached by browsers and we'd miss analytics
    res.redirect(302, longUrl);
  })
);

/**
 * Extended version of getUrlByShortCode that returns cache hit information.
 * Used to track cache performance in metrics.
 */
async function getUrlByShortCodeWithCacheInfo(
  shortCode: string
): Promise<{ longUrl: string; cacheHit: boolean } | null> {
  // Import here to avoid circular dependency
  const { urlCache } = await import('../utils/cache.js');
  const { query } = await import('../utils/database.js');

  // Check cache first
  const cached = await urlCache.get(shortCode);
  if (cached) {
    return { longUrl: cached, cacheHit: true };
  }

  // Cache miss - query database
  interface UrlRow {
    short_code: string;
    long_url: string;
    is_active: boolean;
    expires_at: Date | null;
  }

  const result = await query<UrlRow>(
    `SELECT * FROM urls
     WHERE short_code = $1
     AND is_active = true
     AND (expires_at IS NULL OR expires_at > NOW())`,
    [shortCode]
  );

  if (result.length === 0) {
    return null;
  }

  const url = result[0];

  // Update cache
  await urlCache.set(shortCode, url.long_url);

  return { longUrl: url.long_url, cacheHit: false };
}

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
