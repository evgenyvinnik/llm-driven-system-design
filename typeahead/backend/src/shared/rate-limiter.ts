/**
 * Rate limiting middleware for typeahead API.
 *
 * WHY rate limiting is CRITICAL for typeahead:
 * - Prevents search abuse (bots, scrapers, DoS)
 * - Protects expensive trie operations from overload
 * - Ensures fair resource allocation across users
 * - Maintains low latency for legitimate users
 */
import rateLimit, { ipKeyGenerator, type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import logger, { auditLogger } from './logger.js';
import { rateLimitMetrics } from './metrics.js';

interface RateLimiterOptions {
  windowMs?: number;
  max?: number;
  keyPrefix?: string;
}

/**
 * Key generator for rate limiting: the client IP only.
 * Client-sent headers (X-User-Id, X-Forwarded-For) are never trusted directly, since a client
 * could rotate them to get a fresh bucket per request or aim them at another client's bucket.
 * req.ip honours X-Forwarded-For only when Express's 'trust proxy' is configured (TRUST_PROXY
 * in index.ts). ipKeyGenerator groups IPv6 addresses by subnet so one host can't rotate addresses.
 */
function getClientIdentifier(req: Request): string {
  return req.ip ? ipKeyGenerator(req.ip) : 'anonymous';
}

/**
 * Count requests a limiter let through. express-rate-limit calls `skip` before deciding,
 * so counting there would include rejected requests; the limiter only calls next() when
 * the request is allowed (its handler answers 429 otherwise).
 */
function countAllowed(
  endpoint: string,
  limiter: RateLimitRequestHandler,
  isExempt: (req: Request) => boolean = () => false
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    void limiter(req, res, (err?: unknown) => {
      if (!err && !isExempt(req)) {
        rateLimitMetrics.allowed.inc({ endpoint });
      }
      next(err);
    });
  };
}

/**
 * Probe and scrape endpoints exempt from the global limiter, so heavy traffic from the
 * prober's address can't make an instance look unready.
 */
function isHealthOrMetrics(req: Request): boolean {
  return req.path === '/health' || req.path.startsWith('/health/') || req.path === '/metrics';
}

/**
 * Rate limiter for suggestion queries
 * More permissive since users type quickly
 */
export const suggestionRateLimiter: RequestHandler = countAllowed('suggestions', rateLimit({
  windowMs: 1000, // 1 second window
  max: 20, // 20 requests per second (fast typing)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const clientId = getClientIdentifier(req);

    // Log rate limit hit
    auditLogger.logRateLimitViolation(clientId, 'suggestions', options.max as number, options.max as number);
    rateLimitMetrics.hits.inc({ endpoint: 'suggestions' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please slow down.',
      retryAfter: Math.ceil((options.windowMs as number) / 1000),
    });
  },
}));

/**
 * Rate limiter for query logging (POST /log)
 * Stricter since it writes to database
 */
export const logRateLimiter: RequestHandler = countAllowed('log', rateLimit({
  windowMs: 1000, // 1 second window
  max: 5, // 5 log requests per second
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'log', options.max as number, options.max as number);
    rateLimitMetrics.hits.inc({ endpoint: 'log' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded for logging.',
      retryAfter: Math.ceil((options.windowMs as number) / 1000),
    });
  },
}));

/**
 * Rate limiter for admin operations
 * Very strict since admin operations are expensive
 */
export const adminRateLimiter: RequestHandler = countAllowed('admin', rateLimit({
  windowMs: 60000, // 1 minute window
  max: 30, // 30 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'admin', options.max as number, options.max as number);
    rateLimitMetrics.hits.inc({ endpoint: 'admin' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Admin rate limit exceeded.',
      retryAfter: Math.ceil((options.windowMs as number) / 1000),
    });
  },
}));

/**
 * Global rate limiter for all API endpoints
 * Catches any abuse not caught by specific limiters
 */
export const globalRateLimiter: RequestHandler = countAllowed('global', rateLimit({
  windowMs: 60000, // 1 minute window
  max: 1000, // 1000 requests per minute globally
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req: Request, res: Response, _next: NextFunction, options: Options) => {
    const clientId = getClientIdentifier(req);

    auditLogger.logRateLimitViolation(clientId, 'global', options.max as number, options.max as number);
    rateLimitMetrics.hits.inc({ endpoint: 'global' });

    res.status(429).json({
      error: 'Too Many Requests',
      message: 'Global rate limit exceeded.',
      retryAfter: Math.ceil((options.windowMs as number) / 1000),
    });
  },
  // Skip health/readiness probes and metrics scrapes
  skip: isHealthOrMetrics,
}), isHealthOrMetrics);

/**
 * Create a Redis-backed rate limiter (for distributed deployments)
 * Requires redis client to be passed
 */
export function createRedisRateLimiter(
  redis: Redis,
  options: RateLimiterOptions = {}
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { windowMs = 1000, max = 20, keyPrefix = 'rl' } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded.',
          retryAfter: Math.ceil(windowMs / 1000),
          current,
          limit: max,
        });
        return;
      }

      rateLimitMetrics.allowed.inc({ endpoint: keyPrefix });
      next();
    } catch (error) {
      // If Redis fails, allow the request (fail open)
      logger.error({
        event: 'rate_limit_error',
        error: (error as Error).message,
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
