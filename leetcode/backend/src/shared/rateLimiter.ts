import rateLimit, { type Options, ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response } from 'express';
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
  return `ip:${ipKeyGenerator(req.ip || '0.0.0.0')}`;
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
    ip: ipKeyGenerator(req.ip || '0.0.0.0'),
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

// Handler shared by the two auth limiters (always keyed by IP: there is no user yet)
const authLimitHandler = (message: string) => (req: Request, res: Response, _next: unknown, options: Options): void => {
  logger.warn({
    ip: ipKeyGenerator(req.ip || '0.0.0.0'),
    path: req.path
  }, 'Auth rate limit exceeded');

  metrics.rateLimitHits.inc({
    endpoint: '/auth',
    user_type: 'anonymous'
  });

  const retryAfter = Math.ceil(options.windowMs / 1000);
  res.status(429).json({
    error: 'Too many attempts',
    message,
    retryAfter
  });
};

/**
 * Login rate limiter
 * - Brute-force protection: 5 failed logins per 15 minutes per IP
 * - Successful logins are not counted (skipSuccessfulRequests). Counting them locked out
 *   anyone who simply logged in five times, including the smoke tests and screenshot runs.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 failed attempts
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `login:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
  handler: authLimitHandler('Too many failed login attempts. Please wait 15 minutes before trying again.')
});

/**
 * Registration rate limiter
 * - Slows down bulk account creation: 5 registrations per hour per IP
 * - Every attempt counts, successful or not
 */
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `register:${ipKeyGenerator(req.ip || '0.0.0.0')}`,
  handler: authLimitHandler('Too many registrations from this address. Please try again later.')
});
