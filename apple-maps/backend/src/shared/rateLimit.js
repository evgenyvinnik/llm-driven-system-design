import rateLimit from 'express-rate-limit';
import logger from './logger.js';
import { rateLimitHits } from './metrics.js';

/**
 * Rate Limiting Module
 *
 * WHY: Rate limiting protects the system by:
 * - Preventing abuse and DoS attacks
 * - Ensuring fair usage across clients
 * - Protecting downstream services from overload
 * - Providing predictable SLAs
 *
 * Strategy:
 * - Different limits for different endpoints based on cost
 * - More generous limits for read operations
 * - Stricter limits for write/compute-intensive operations
 * - Per-IP rate limiting (can be extended to per-user)
 */

/**
 * Create a rate limiter with custom options
 * @param {Object} options - Rate limiter configuration
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60000, // 1 minute
    max = 100, // 100 requests per window
    message = 'Too many requests, please try again later',
    routeName = 'unknown',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
  } = options;

  return rateLimit({
    windowMs,
    max,
    message: { error: message, retryAfter: Math.ceil(windowMs / 1000) },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false, // Disable X-RateLimit-* headers

    // Use IP as key (can be extended for authenticated users)
    keyGenerator: (req) => {
      // Use X-Forwarded-For if behind a proxy
      const forwarded = req.headers['x-forwarded-for'];
      const ip = forwarded ? forwarded.split(',')[0].trim() : req.ip;
      return ip;
    },

    // Log and track when rate limit is hit
    handler: (req, res, next, options) => {
      const ip = req.ip;
      logger.warn(
        { ip: ip?.replace(/\d+$/, 'xxx'), route: routeName, limit: max },
        'Rate limit exceeded'
      );
      rateLimitHits.inc({ route: routeName });
      res.status(429).json({
        error: message,
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },

    skipSuccessfulRequests,
    skipFailedRequests,
  });
}

// ============================================================
// Preconfigured Rate Limiters
// ============================================================

/**
 * General API rate limiter
 * 100 requests per minute per IP
 */
const generalLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 100,
  message: 'Too many requests, please try again later',
  routeName: 'general',
});

/**
 * Routing endpoint rate limiter
 * Route calculation is expensive - limit to 30 per minute
 */
const routingLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 30,
  message: 'Too many routing requests. Please wait before calculating more routes.',
  routeName: 'routing',
});

/**
 * Search endpoint rate limiter
 * Search is moderately expensive - limit to 60 per minute
 */
const searchLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 60,
  message: 'Too many search requests. Please slow down.',
  routeName: 'search',
});

/**
 * Geocoding rate limiter
 * Geocoding can be expensive - limit to 45 per minute
 */
const geocodingLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 45,
  message: 'Too many geocoding requests. Please try again later.',
  routeName: 'geocoding',
});

/**
 * Traffic data rate limiter
 * Traffic data is frequently requested - allow 120 per minute
 */
const trafficLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 120,
  message: 'Too many traffic data requests.',
  routeName: 'traffic',
});

/**
 * Incident reporting rate limiter
 * Prevent spam - limit to 10 per minute
 */
const incidentReportLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 10,
  message: 'Too many incident reports. Please wait before reporting again.',
  routeName: 'incident_report',
});

/**
 * Location update rate limiter (for navigation)
 * High frequency but simple - allow 600 per minute (10/sec)
 */
const locationUpdateLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 600,
  message: 'Too many location updates.',
  routeName: 'location_update',
  skipSuccessfulRequests: true, // Only count failed requests
});

/**
 * Map data rate limiter
 * Map tiles/nodes/segments - allow 200 per minute
 */
const mapDataLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 200,
  message: 'Too many map data requests.',
  routeName: 'map_data',
});

/**
 * Strict rate limiter for sensitive operations
 * 5 requests per minute
 */
const strictLimiter = createRateLimiter({
  windowMs: 60000, // 1 minute
  max: 5,
  message: 'Rate limit exceeded for sensitive operation.',
  routeName: 'strict',
});

export {
  createRateLimiter,
  generalLimiter,
  routingLimiter,
  searchLimiter,
  geocodingLimiter,
  trafficLimiter,
  incidentReportLimiter,
  locationUpdateLimiter,
  mapDataLimiter,
  strictLimiter,
};
