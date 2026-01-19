import rateLimit from 'express-rate-limit';
import type { Request, Response, Options } from 'express-rate-limit';
import { createModuleLogger } from './logger.js';
import { metrics } from './metrics.js';

const logger = createModuleLogger('rate-limiter');

/**
 * Rate limiting configuration
 *
 * Rate limiting protects execution resources by preventing users from
 * overwhelming the system with submission requests. Without it, a single
 * user could consume all available Docker containers.
 */

// Key generator that uses user ID if authenticated, IP otherwise
const keyGenerator = (req: Request): string => {
  if (req.session && req.session.userId) {
    return `user:${req.session.userId}`;
  }
  return `ip:${req.ip}`;
};

// Normalize endpoint for metrics (reduce cardinality)
function normalizeEndpoint(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

// Handler for when rate limit is exceeded
const limitHandler = (req: Request, res: Response, _next: unknown, options: Options): void => {
  const userType = req.session?.userId ? 'authenticated' : 'anonymous';
  const endpoint = req.path;

  logger.warn({
    userId: req.session?.userId,
    ip: req.ip,
    path: req.path,
    method: req.method,
    userType
  }, 'Rate limit exceeded');

  metrics.rateLimitHits.inc({
    endpoint: normalizeEndpoint(endpoint),
    user_type: userType
  });

  res.status(429).json({
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please wait before trying again.',
    retryAfter: Math.ceil(options.windowMs / 1000)
  });
};

/**
 * Rate limiter for code submissions
 * - Limits submissions to protect Docker execution resources
 * - 10 submissions per minute per user
 */
export const submissionRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 10, // 10 submissions per minute
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  keyGenerator,
  handler: limitHandler,
  message: {
    error: 'Too many submissions',
    message: 'You can submit up to 10 solutions per minute. Please wait.'
  },
  skip: (req: Request) => {
    // Allow admins to bypass rate limiting
    return req.session?.role === 'admin';
  }
});

/**
 * Rate limiter for code runs (test execution without saving)
 * - More lenient than submissions
 * - 30 runs per minute per user
 */
export const codeRunRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // 30 test runs per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: limitHandler,
  message: {
    error: 'Too many code runs',
    message: 'You can run up to 30 tests per minute. Please wait.'
  },
  skip: (req: Request) => {
    return req.session?.role === 'admin';
  }
});

/**
 * General API rate limiter
 * - Applies to all API endpoints
 * - 100 requests per minute per user/IP
 */
export const generalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator,
  handler: limitHandler,
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please slow down.'
  }
});

/**
 * Auth rate limiter for login/register
 * - Prevents brute force attacks
 * - 5 attempts per 15 minutes per IP
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `auth:${req.ip}`, // Always use IP for auth
  handler: (req: Request, res: Response) => {
    logger.warn({
      ip: req.ip,
      path: req.path
    }, 'Auth rate limit exceeded');

    metrics.rateLimitHits.inc({
      endpoint: '/auth',
      user_type: 'anonymous'
    });

    res.status(429).json({
      error: 'Too many login attempts',
      message: 'Please wait 15 minutes before trying again.',
      retryAfter: 900
    });
  }
});
