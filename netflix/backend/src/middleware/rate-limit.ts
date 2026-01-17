/**
 * Rate Limiting Middleware.
 *
 * Implements sliding window rate limiting using Redis.
 * Protects API endpoints from abuse and ensures fair usage.
 *
 * Features:
 * - Per-user/per-IP rate limiting
 * - Tiered limits by endpoint category
 * - Redis-based sliding window for accurate limiting
 * - Automatic rate limit headers
 *
 * Rate Limit Tiers:
 * | Endpoint Category | Limit | Window | Burst |
 * |-------------------|-------|--------|-------|
 * | Browse/Search     | 100   | 1 min  | 20    |
 * | Playback Start    | 30    | 1 min  | 5     |
 * | Profile Updates   | 20    | 1 min  | 5     |
 * | Progress Updates  | 60    | 1 min  | 10    |
 * | Admin APIs        | 200   | 1 min  | 50    |
 * | Auth (login)      | 5     | 5 min  | 2     |
 */
import { Request, Response, NextFunction } from 'express';
import { redis } from '../services/redis.js';
import { logger } from '../services/logger.js';
import { rateLimitExceeded } from '../services/metrics.js';

/**
 * Rate limit configuration for an endpoint category.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional: Skip rate limiting for certain conditions */
  skip?: (req: Request) => boolean;
}

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** When the rate limit resets */
  resetAt: Date;
  /** Total limit for the window */
  limit: number;
}

/**
 * Predefined rate limit configurations by category.
 */
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  browse: { limit: 100, windowSeconds: 60 },
  playback: { limit: 30, windowSeconds: 60 },
  profile: { limit: 20, windowSeconds: 60 },
  progress: { limit: 60, windowSeconds: 60 },
  admin: { limit: 200, windowSeconds: 60 },
  auth: { limit: 5, windowSeconds: 300 },
  default: { limit: 60, windowSeconds: 60 },
};

/**
 * Redis key prefix for rate limiting.
 */
const RATE_LIMIT_PREFIX = 'ratelimit:';

/**
 * Checks rate limit for a given key using sliding window algorithm.
 *
 * @param key - Unique identifier for rate limiting (e.g., user:123:browse)
 * @param config - Rate limit configuration
 * @returns Rate limit check result
 */
async function checkRateLimit(key: string, config: RateLimitConfig): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - (config.windowSeconds * 1000);
  const fullKey = `${RATE_LIMIT_PREFIX}${key}`;

  try {
    // Use Redis transaction for atomic operations
    const multi = redis.multi();

    // Remove old entries outside the window
    multi.zremrangebyscore(fullKey, 0, windowStart);

    // Add current request with timestamp
    multi.zadd(fullKey, now, `${now}:${Math.random().toString(36).substr(2, 9)}`);

    // Count requests in window
    multi.zcard(fullKey);

    // Set expiry on the key
    multi.expire(fullKey, config.windowSeconds);

    const results = await multi.exec();

    // Get count from results (third command, index 2)
    const count = (results?.[2]?.[1] as number) || 0;

    const allowed = count <= config.limit;
    const remaining = Math.max(0, config.limit - count);
    const resetAt = new Date(now + config.windowSeconds * 1000);

    return {
      allowed,
      remaining,
      resetAt,
      limit: config.limit,
    };
  } catch (error) {
    // If Redis fails, allow the request (fail open for availability)
    logger.error({ error, key }, 'Rate limiting Redis error - allowing request');
    return {
      allowed: true,
      remaining: config.limit,
      resetAt: new Date(Date.now() + config.windowSeconds * 1000),
      limit: config.limit,
    };
  }
}

/**
 * Gets the rate limiting key identifier from request.
 * Uses accountId if authenticated, otherwise IP address.
 *
 * @param req - Express request object
 * @param category - Endpoint category
 * @returns Rate limit key
 */
function getRateLimitKey(req: Request, category: string): string {
  // Use accountId if authenticated, otherwise use IP
  const identifier = req.accountId || req.ip || 'unknown';
  return `${category}:${identifier}`;
}

/**
 * Sets rate limit headers on the response.
 *
 * @param res - Express response object
 * @param result - Rate limit check result
 */
function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.set({
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetAt.toISOString(),
  });
}

/**
 * Creates rate limiting middleware for a specific category.
 *
 * @param category - Endpoint category (browse, playback, auth, etc.)
 * @param customConfig - Optional custom configuration override
 * @returns Express middleware function
 *
 * @example
 * router.get('/search', rateLimit('browse'), (req, res) => { ... });
 * router.post('/login', rateLimit('auth'), (req, res) => { ... });
 */
export function rateLimit(
  category: string,
  customConfig?: Partial<RateLimitConfig>
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const baseConfig = RATE_LIMIT_CONFIGS[category] || RATE_LIMIT_CONFIGS.default;
  const config: RateLimitConfig = { ...baseConfig, ...customConfig };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Skip rate limiting if configured
    if (config.skip && config.skip(req)) {
      next();
      return;
    }

    const key = getRateLimitKey(req, category);
    const result = await checkRateLimit(key, config);

    // Always set rate limit headers
    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      // Track rate limit exceeded
      rateLimitExceeded.labels(category).inc();

      logger.warn({
        category,
        key,
        limit: result.limit,
        resetAt: result.resetAt.toISOString(),
      }, 'Rate limit exceeded');

      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
        limit: result.limit,
        windowSeconds: config.windowSeconds,
      });
      return;
    }

    next();
  };
}

/**
 * Stricter rate limiting for sensitive operations.
 * Uses both IP and account-based limiting.
 *
 * @param category - Endpoint category
 * @returns Express middleware function
 */
export function strictRateLimit(
  category: string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const config = RATE_LIMIT_CONFIGS[category] || RATE_LIMIT_CONFIGS.auth;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Check both IP-based and account-based limits
    const ipKey = `${category}:ip:${req.ip || 'unknown'}`;
    const ipResult = await checkRateLimit(ipKey, config);

    if (!ipResult.allowed) {
      setRateLimitHeaders(res, ipResult);
      rateLimitExceeded.labels(`${category}:ip`).inc();

      res.status(429).json({
        error: 'Too many requests from this IP',
        retryAfter: Math.ceil((ipResult.resetAt.getTime() - Date.now()) / 1000),
      });
      return;
    }

    // If authenticated, also check account-based limit
    if (req.accountId) {
      const accountKey = `${category}:account:${req.accountId}`;
      const accountResult = await checkRateLimit(accountKey, config);

      if (!accountResult.allowed) {
        setRateLimitHeaders(res, accountResult);
        rateLimitExceeded.labels(`${category}:account`).inc();

        res.status(429).json({
          error: 'Too many requests from this account',
          retryAfter: Math.ceil((accountResult.resetAt.getTime() - Date.now()) / 1000),
        });
        return;
      }
    }

    setRateLimitHeaders(res, ipResult);
    next();
  };
}

/**
 * Dynamic rate limiting based on user tier or subscription.
 *
 * @param getTier - Function to extract user tier from request
 * @param tierLimits - Map of tier to limit multiplier
 * @param baseCategory - Base category for rate limits
 * @returns Express middleware function
 */
export function tieredRateLimit(
  getTier: (req: Request) => string,
  tierLimits: Record<string, number>,
  baseCategory: string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tier = getTier(req);
    const multiplier = tierLimits[tier] || 1;
    const baseConfig = RATE_LIMIT_CONFIGS[baseCategory] || RATE_LIMIT_CONFIGS.default;

    const config: RateLimitConfig = {
      ...baseConfig,
      limit: Math.floor(baseConfig.limit * multiplier),
    };

    const key = getRateLimitKey(req, `${baseCategory}:${tier}`);
    const result = await checkRateLimit(key, config);

    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      rateLimitExceeded.labels(baseCategory).inc();
      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((result.resetAt.getTime() - Date.now()) / 1000),
        tier,
        limit: result.limit,
      });
      return;
    }

    next();
  };
}

/**
 * Clears rate limit for a specific key.
 * Useful for testing or admin operations.
 *
 * @param key - Rate limit key to clear
 */
export async function clearRateLimit(key: string): Promise<void> {
  await redis.del(`${RATE_LIMIT_PREFIX}${key}`);
}

/**
 * Gets current rate limit status for a key.
 *
 * @param key - Rate limit key
 * @param config - Rate limit configuration
 * @returns Current rate limit status
 */
export async function getRateLimitStatus(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - (config.windowSeconds * 1000);
  const fullKey = `${RATE_LIMIT_PREFIX}${key}`;

  const count = await redis.zcount(fullKey, windowStart, now);

  return {
    allowed: count < config.limit,
    remaining: Math.max(0, config.limit - count),
    resetAt: new Date(now + config.windowSeconds * 1000),
    limit: config.limit,
  };
}
