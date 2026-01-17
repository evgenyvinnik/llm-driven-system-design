import rateLimit from 'express-rate-limit';
import { rateLimitHitsTotal } from './metrics.js';
import { logAuditEvent } from './logger.js';

/**
 * Rate limit configuration for different endpoints
 * Using token bucket algorithm via express-rate-limit
 */

/**
 * Search rate limiter
 * - 100 requests per 10 seconds (window)
 * - Prevents search endpoint abuse
 * - Returns 429 with retry-after header
 */
export const searchRateLimiter = rateLimit({
  windowMs: 10 * 1000,  // 10 second window
  max: 100,             // 100 requests per window
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,  // Disable X-RateLimit-* headers
  message: {
    error: 'Too many search requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfterSeconds: 10
  },
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise IP
    return req.session?.userId || req.ip;
  },
  handler: (req, res, next, options) => {
    // Track rate limit hits in metrics
    rateLimitHitsTotal.labels('/api/search').inc();

    // Log audit event for rate limiting
    logAuditEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      userId: req.session?.userId || null,
      ip: req.ip,
      details: {
        route: '/api/search',
        windowMs: options.windowMs,
        max: options.max
      }
    });

    res.status(429).json(options.message);
  },
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health' || req.path === '/metrics';
  }
});

/**
 * Suggestions rate limiter
 * - 30 requests per 10 seconds
 * - Lower limit since suggestions are called frequently during typing
 */
export const suggestionsRateLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many suggestion requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfterSeconds: 10
  },
  keyGenerator: (req) => {
    return req.session?.userId || req.ip;
  },
  handler: (req, res, next, options) => {
    rateLimitHitsTotal.labels('/api/suggestions').inc();
    logAuditEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      userId: req.session?.userId || null,
      ip: req.ip,
      details: {
        route: '/api/suggestions',
        windowMs: options.windowMs,
        max: options.max
      }
    });
    res.status(429).json(options.message);
  }
});

/**
 * Index operations rate limiter
 * - 50 requests per minute
 * - Higher limit for indexing but with longer window
 */
export const indexRateLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute window
  max: 50,              // 50 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many index requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfterSeconds: 60
  },
  keyGenerator: (req) => {
    return req.session?.userId || req.ip;
  },
  handler: (req, res, next, options) => {
    rateLimitHitsTotal.labels('/api/index').inc();
    logAuditEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      userId: req.session?.userId || null,
      ip: req.ip,
      details: {
        route: '/api/index',
        windowMs: options.windowMs,
        max: options.max
      }
    });
    res.status(429).json(options.message);
  }
});

/**
 * Bulk operations rate limiter
 * - 5 requests per minute
 * - Very low limit since bulk operations are expensive
 */
export const bulkRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many bulk requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfterSeconds: 60
  },
  keyGenerator: (req) => {
    return req.session?.userId || req.ip;
  },
  handler: (req, res, next, options) => {
    rateLimitHitsTotal.labels('/api/index/bulk').inc();
    logAuditEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      userId: req.session?.userId || null,
      ip: req.ip,
      details: {
        route: '/api/index/bulk',
        windowMs: options.windowMs,
        max: options.max
      }
    });
    res.status(429).json(options.message);
  }
});

/**
 * Global rate limiter for all API endpoints
 * - 500 requests per minute
 * - Acts as a safety net
 */
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests, please try again later',
    code: 'RATE_LIMIT_EXCEEDED',
    retryAfterSeconds: 60
  },
  keyGenerator: (req) => {
    return req.ip;
  },
  handler: (req, res, next, options) => {
    rateLimitHitsTotal.labels('global').inc();
    logAuditEvent({
      eventType: 'RATE_LIMIT_EXCEEDED',
      userId: req.session?.userId || null,
      ip: req.ip,
      details: {
        route: 'global',
        path: req.path,
        windowMs: options.windowMs,
        max: options.max
      }
    });
    res.status(429).json(options.message);
  },
  skip: (req) => {
    // Skip rate limiting for health checks and metrics
    return req.path === '/health' || req.path === '/metrics';
  }
});

/**
 * Create a custom rate limiter with specified options
 * @param {Object} options - Rate limiter options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.max - Maximum requests per window
 * @param {string} options.routeName - Name for metrics tracking
 * @returns {Function} - Express middleware
 */
export function createRateLimiter({ windowMs, max, routeName }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests, please try again later',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: Math.ceil(windowMs / 1000)
    },
    keyGenerator: (req) => {
      return req.session?.userId || req.ip;
    },
    handler: (req, res, next, options) => {
      rateLimitHitsTotal.labels(routeName).inc();
      logAuditEvent({
        eventType: 'RATE_LIMIT_EXCEEDED',
        userId: req.session?.userId || null,
        ip: req.ip,
        details: {
          route: routeName,
          windowMs: options.windowMs,
          max: options.max
        }
      });
      res.status(429).json(options.message);
    }
  });
}

export default {
  searchRateLimiter,
  suggestionsRateLimiter,
  indexRateLimiter,
  bulkRateLimiter,
  globalRateLimiter,
  createRateLimiter
};
