import { redisClient } from '../db.js';
import logger from './logger.js';
import { rateLimitHitsTotal } from './metrics.js';

/**
 * Rate limiting using Redis sliding window algorithm.
 * More accurate than token bucket and prevents burst abuse.
 */
export async function checkRateLimit(key, limit, windowSec) {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const fullKey = `ratelimit:${key}`;

  try {
    // Use pipeline for atomic operations
    const multi = redisClient.multi();

    // Remove old entries outside the window
    multi.zRemRangeByScore(fullKey, 0, windowStart);

    // Add current request with timestamp as score and unique member
    const member = `${now}:${Math.random().toString(36).substring(7)}`;
    multi.zAdd(fullKey, { score: now, value: member });

    // Count requests in window
    multi.zCard(fullKey);

    // Set expiry on the key
    multi.expire(fullKey, windowSec);

    const results = await multi.exec();
    const count = results[2];

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: new Date(now + windowSec * 1000),
      count,
    };
  } catch (error) {
    // On Redis failure, allow the request but log the error
    logger.error({ error, key }, 'Rate limit check failed');
    return {
      allowed: true,
      remaining: limit,
      resetAt: new Date(now + windowSec * 1000),
      count: 0,
    };
  }
}

/**
 * Rate limit middleware factory.
 *
 * @param {number} limit - Maximum requests allowed in the window
 * @param {number} windowSec - Window size in seconds
 * @param {Function} keyFn - Function to extract rate limit key from request
 * @param {string} endpointName - Name of the endpoint for metrics
 */
export function rateLimitMiddleware(limit, windowSec, keyFn, endpointName = 'default') {
  return async (req, res, next) => {
    const keyValue = keyFn(req);
    const scope = req.session?.userId ? 'user' : 'ip';

    const result = await checkRateLimit(keyValue, limit, windowSec);

    // Set rate limit headers
    res.set('X-RateLimit-Limit', limit.toString());
    res.set('X-RateLimit-Remaining', result.remaining.toString());
    res.set('X-RateLimit-Reset', result.resetAt.toISOString());

    if (!result.allowed) {
      rateLimitHitsTotal.inc({ endpoint: endpointName, scope });

      const log = req.log || logger;
      log.warn(
        {
          key: keyValue,
          limit,
          windowSec,
          endpoint: endpointName,
        },
        'Rate limit exceeded'
      );

      return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }

    next();
  };
}

// Pre-configured rate limiters for different endpoint categories
export const rateLimiters = {
  // Auth endpoints - strict limits to prevent brute force
  auth: rateLimitMiddleware(
    5, // 5 requests
    900, // per 15 minutes
    (req) => `auth:${req.ip}`,
    'auth'
  ),

  // Search endpoints - moderate limits
  search: rateLimitMiddleware(
    60, // 60 requests
    60, // per minute
    (req) => `search:${req.session?.userId || req.ip}`,
    'search'
  ),

  // Playback (stream URLs) - higher limits for active listening
  playback: rateLimitMiddleware(
    300, // 300 requests
    60, // per minute
    (req) => `playback:${req.session?.userId || req.ip}`,
    'playback'
  ),

  // Library writes - moderate limits
  libraryWrite: rateLimitMiddleware(
    100, // 100 requests
    60, // per minute
    (req) => `library:${req.session?.userId || req.ip}`,
    'library'
  ),

  // Playlist writes - moderate limits
  playlistWrite: rateLimitMiddleware(
    60, // 60 requests
    60, // per minute
    (req) => `playlist:${req.session?.userId || req.ip}`,
    'playlist'
  ),

  // Recommendations - lower limits as they are expensive
  recommendations: rateLimitMiddleware(
    30, // 30 requests
    60, // per minute
    (req) => `recs:${req.session?.userId || req.ip}`,
    'recommendations'
  ),

  // Admin endpoints - higher limits
  admin: rateLimitMiddleware(
    1000, // 1000 requests
    60, // per minute
    (req) => `admin:${req.session?.userId || req.ip}`,
    'admin'
  ),
};

export default {
  checkRateLimit,
  rateLimitMiddleware,
  rateLimiters,
};
