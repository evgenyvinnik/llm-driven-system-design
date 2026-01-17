import rateLimit, { Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from '../db/redis.js';
import { createComponentLogger } from './logger.js';
import { rateLimitHits } from './metrics.js';
import { Request, Response } from 'express';

/**
 * Rate limiting middleware for API protection.
 *
 * WHY RATE LIMITING:
 * - Prevent DoS attacks: Limit impact of malicious traffic
 * - Fair usage: Ensure all users get reasonable access
 * - Cost control: Prevent runaway resource consumption
 * - Abuse prevention: Limit automated scraping/spamming
 *
 * IMPLEMENTATION:
 * - Uses Redis as a distributed store (works across multiple server instances)
 * - Sliding window algorithm for smooth rate limiting
 * - Different limits for different endpoints based on expected usage
 *
 * RATE LIMIT TIERS:
 * - Location reports: High limit (100/min) - crowd-sourced network needs throughput
 * - Location queries: Medium limit (60/min) - normal user usage
 * - Authentication: Low limit (10/min) - prevent brute force
 * - Admin endpoints: Very low limit (20/min) - sensitive operations
 *
 * RESPONSE HEADERS:
 * - X-RateLimit-Limit: Maximum requests allowed
 * - X-RateLimit-Remaining: Requests remaining in window
 * - X-RateLimit-Reset: Unix timestamp when limit resets
 * - Retry-After: Seconds until client can retry (only when limited)
 */

const log = createComponentLogger('rateLimit');

/**
 * Create a Redis-backed rate limiter with customizable options.
 *
 * @param options - Rate limiter configuration
 * @returns Express rate limiting middleware
 */
function createRateLimiter(options: {
  windowMs: number;
  max: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  message?: string;
  endpoint?: string;
}) {
  const limiterOptions: Partial<Options> = {
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true, // Return rate limit info in RateLimit-* headers
    legacyHeaders: false, // Disable X-RateLimit-* headers (use standard)

    // Use Redis for distributed rate limiting
    store: new RedisStore({
      // Use 'call' instead of deprecated 'sendCommand'
      sendCommand: async (...args: string[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return redis.call(args[0], ...args.slice(1)) as any;
      },
      prefix: 'findmy:ratelimit:',
    }),

    // Custom key generator (default: IP address)
    keyGenerator: options.keyGenerator || ((req: Request) => {
      // Use X-Forwarded-For if behind a proxy, otherwise use IP
      return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.ip ||
        'unknown';
    }),

    // Skip rate limiting for specific requests
    skip: options.skip || (() => false),

    // Custom response when rate limited
    handler: (req: Request, res: Response) => {
      const endpoint = options.endpoint || req.path;
      log.warn(
        { ip: req.ip, endpoint, path: req.path },
        'Rate limit exceeded'
      );
      rateLimitHits.inc({ endpoint });

      res.status(429).json({
        error: 'Too many requests',
        message: options.message || 'Please slow down and try again later',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    },
  };

  return rateLimit(limiterOptions);
}

/**
 * Rate limiter for location report submissions.
 *
 * High limit (100/minute) because:
 * - Crowd-sourced network relies on high throughput
 * - Mobile devices may batch multiple reports
 * - Reports are cheap to process (just storage)
 */
export const locationReportLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  endpoint: 'location_report',
  message: 'Too many location reports. Please wait before submitting more.',
});

/**
 * Rate limiter for location queries.
 *
 * Medium limit (60/minute) because:
 * - Users check locations frequently during active tracking
 * - Queries involve decryption (more CPU intensive)
 * - Normal usage is ~1 query per minute per device
 */
export const locationQueryLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  endpoint: 'location_query',
  message: 'Too many location queries. Please wait before checking again.',
});

/**
 * Rate limiter for authentication endpoints.
 *
 * Low limit (10/minute) to prevent:
 * - Brute force password attacks
 * - Credential stuffing
 * - Account enumeration
 */
export const authLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 attempts per minute
  endpoint: 'auth',
  message: 'Too many login attempts. Please wait before trying again.',
});

/**
 * Rate limiter for device registration.
 *
 * Low limit (20/minute) because:
 * - Device registration is infrequent (setup only)
 * - Creates database records and secrets
 * - Prevents automated device farming
 */
export const deviceRegistrationLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  endpoint: 'device_registration',
  message: 'Too many device registrations. Please wait before adding more devices.',
});

/**
 * Rate limiter for admin endpoints.
 *
 * Very low limit (20/minute) because:
 * - Admin operations are sensitive
 * - Should be infrequent (monitoring/investigation)
 * - Higher cost operations (aggregations, full scans)
 */
export const adminLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  endpoint: 'admin',
  message: 'Too many admin requests. Please slow down.',
});

/**
 * General API rate limiter for endpoints without specific limits.
 *
 * Default limit (100/minute) provides baseline protection.
 */
export const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  endpoint: 'general',
  message: 'Too many requests. Please slow down and try again later.',
});

/**
 * Rate limiter that uses both IP and user ID for authenticated routes.
 * Prevents a single authenticated user from consuming all resources.
 *
 * @param maxPerMinute - Maximum requests per minute per user
 * @returns Rate limiter middleware
 */
export function perUserRateLimiter(maxPerMinute: number) {
  return createRateLimiter({
    windowMs: 60 * 1000,
    max: maxPerMinute,
    keyGenerator: (req: Request) => {
      // Use user ID if authenticated, otherwise fall back to IP
      const userId = (req.session as { userId?: string })?.userId;
      return userId || req.ip || 'unknown';
    },
    endpoint: 'per_user',
    message: 'You have made too many requests. Please wait before trying again.',
  });
}

export { createRateLimiter };
