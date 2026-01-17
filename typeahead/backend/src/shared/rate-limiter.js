/**
 * Rate limiting middleware for typeahead API.
 *
 * WHY rate limiting is CRITICAL for typeahead:
 * - Prevents search abuse (bots, scrapers, DoS)
 * - Protects expensive trie operations from overload
 * - Ensures fair resource allocation across users
 * - Maintains low latency for legitimate users
 */
import rateLimit from 'express-rate-limit';
import logger, { auditLogger } from './logger.js';
import { rateLimitMetrics } from './metrics.js';

/**
 * Key generator for rate limiting
 * Uses X-Forwarded-For header or IP address
 */
function getClientIdentifier(req) {
  return (
    req.headers['x-user-id'] ||
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.ip ||
    'anonymous'
  );
}

/**
 * Rate limiter for suggestion queries
 * More permissive since users type quickly
 */
export const suggestionRateLimiter = rateLimit({
  windowMs: 1000, // 1 second window
  max: 20, // 20 requests per second (fast typing)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res, next, options) => {
    const clientId = getClientIdentifier(req);

    // Log rate limit hit
    auditLogger.logRateLimitViolation(clientId, 'suggestions', options.current, options.max);
    rateLimitMetrics.hits.inc({ endpoint: 'suggestions' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
  onLimitReached: (req, res, options) => {
    logger.warn({
      event: 'rate_limit_reached',
      clientId: getClientIdentifier(req),
      endpoint: 'suggestions',
      limit: options.max,
    });
  },
  skip: (req) => {
    // Count allowed requests
    rateLimitMetrics.allowed.inc({ endpoint: 'suggestions' });
    return false;
  },
});

/**
 * Rate limiter for query logging (POST /log)
 * Stricter since it writes to database
 */
export const logRateLimiter = rateLimit({
  windowMs: 1000, // 1 second window
  max: 5, // 5 log requests per second
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res, next, options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'log', options.current, options.max);
    rateLimitMetrics.hits.inc({ endpoint: 'log' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded for logging.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
  skip: (req) => {
    rateLimitMetrics.allowed.inc({ endpoint: 'log' });
    return false;
  },
});

/**
 * Rate limiter for admin operations
 * Very strict since admin operations are expensive
 */
export const adminRateLimiter = rateLimit({
  windowMs: 60000, // 1 minute window
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res, next, options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'admin', options.current, options.max);
    rateLimitMetrics.hits.inc({ endpoint: 'admin' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Admin rate limit exceeded.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
  skip: (req) => {
    rateLimitMetrics.allowed.inc({ endpoint: 'admin' });
    return false;
  },
});

/**
 * Global rate limiter for all API endpoints
 * Catches any abuse not caught by specific limiters
 */
export const globalRateLimiter = rateLimit({
  windowMs: 60000, // 1 minute window
  max: 1000, // 1000 requests per minute globally
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res, next, options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'global', options.current, options.max);
    rateLimitMetrics.hits.inc({ endpoint: 'global' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Global rate limit exceeded.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
  skip: (req) => {
    // Skip health checks and metrics
    if (req.path === '/health' || req.path === '/metrics') {
      return true;
    }
    rateLimitMetrics.allowed.inc({ endpoint: 'global' });
    return false;
  },
});

/**
 * Create a Redis-backed rate limiter (for distributed deployments)
 * Requires redis client to be passed
 */
export function createRedisRateLimiter(redis, options = {}) {
  const {
    windowMs = 1000,
    max = 20,
    keyPrefix = 'rl',
  } = options;

  return async (req, res, next) => {
    const clientId = getClientIdentifier(req);
    const key = `${keyPrefix}:${clientId}`;

    try {
      const current = await redis.incr(key);

      if (current === 1) {
        // First request in window, set expiry
        await redis.pexpire(key, windowMs);
      }

      if (current > max) {
        auditLogger.logRateLimitViolation(clientId, keyPrefix, current, max);
        rateLimitMetrics.hits.inc({ endpoint: keyPrefix });

        return res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded.',
          retryAfter: Math.ceil(windowMs / 1000),
          current,
          limit: max,
        });
      }

      rateLimitMetrics.allowed.inc({ endpoint: keyPrefix });
      next();
    } catch (error) {
      // If Redis fails, allow the request (fail open)
      logger.error({
        event: 'rate_limit_error',
        error: error.message,
        clientId,
      });
      next();
    }
  };
}

export default {
  suggestionRateLimiter,
  logRateLimiter,
  adminRateLimiter,
  globalRateLimiter,
  createRedisRateLimiter,
};
