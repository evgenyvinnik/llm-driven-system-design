/**
 * @fileoverview Enhanced rate limiting middleware with Redis sliding window.
 *
 * Implements tiered rate limiting to protect the API and crawl targets:
 *
 * WHY RATE LIMITING:
 * 1. Protects crawl targets: Limits how fast we can inject seed URLs
 * 2. Prevents API abuse: Stops malicious clients from overwhelming the server
 * 3. Fair resource allocation: Ensures no single client monopolizes capacity
 * 4. Cost control: Prevents runaway crawling that could incur infrastructure costs
 *
 * Rate limiting tiers:
 * - Anonymous: Very restrictive (10 req/min) for unauthenticated users
 * - User: Moderate (100 req/min) for regular dashboard usage
 * - Admin: Higher (500 req/min) for administrative operations
 * - Seed injection: Special limit (10 req/min) to prevent frontier flooding
 *
 * @module middleware/rateLimit
 */

import { Request, Response, NextFunction } from 'express';
import { redis } from '../models/redis.js';
import { logger } from '../shared/logger.js';
import { rateLimitHitsCounter } from '../shared/metrics.js';
import { UserRole } from './auth.js';

/**
 * Rate limit configuration per tier.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed */
  limit: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** Optional message when limit exceeded */
  message?: string;
}

/**
 * Rate limit tiers with default configurations.
 */
export const RATE_LIMIT_TIERS: Record<string, RateLimitConfig> = {
  anonymous: {
    limit: 10,
    windowSeconds: 60,
    message: 'Rate limit exceeded. Please authenticate for higher limits.',
  },
  user: {
    limit: 100,
    windowSeconds: 60,
    message: 'Rate limit exceeded. Please wait before making more requests.',
  },
  admin: {
    limit: 500,
    windowSeconds: 60,
    message: 'Rate limit exceeded.',
  },
  seed: {
    limit: 10,
    windowSeconds: 60,
    message: 'Seed injection rate limit exceeded. Max 10 seed requests per minute.',
  },
};

/**
 * Rate limit result from Redis check.
 */
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  total: number;
}

/**
 * Checks rate limit using Redis sliding window algorithm.
 *
 * Uses a sorted set with timestamp scores to implement sliding window:
 * 1. Remove entries older than the window
 * 2. Count remaining entries
 * 3. If under limit, add current request
 *
 * This is more accurate than fixed windows and prevents burst at window edges.
 *
 * @param key - Redis key for this rate limit bucket
 * @param limit - Maximum requests allowed
 * @param windowSeconds - Time window in seconds
 * @returns Rate limit result with remaining count
 */
async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const resetTime = Math.floor((now + windowSeconds * 1000) / 1000);

  // Use Redis pipeline for atomic operations
  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(key, 0, windowStart); // Remove old entries
  pipeline.zcard(key); // Count current entries

  const results = await pipeline.exec();

  if (!results) {
    // Redis error - allow request but log
    logger.error({ key }, 'Rate limit check failed - Redis error');
    return { allowed: true, remaining: limit, resetTime, total: 0 };
  }

  const currentCount = results[1]?.[1] as number ?? 0;

  if (currentCount >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetTime,
      total: currentCount,
    };
  }

  // Add current request with unique ID to avoid collisions
  const requestId = `${now}-${Math.random().toString(36).substring(7)}`;
  await redis.zadd(key, now, requestId);
  await redis.expire(key, windowSeconds);

  return {
    allowed: true,
    remaining: limit - currentCount - 1,
    resetTime,
    total: currentCount + 1,
  };
}

/**
 * Gets the rate limit key for a request.
 * Uses user ID if authenticated, otherwise IP address.
 */
function getRateLimitKey(req: Request, tier: string): string {
  const identifier = req.session?.userId || req.ip || 'unknown';
  return `crawler:ratelimit:${tier}:${identifier}`;
}

/**
 * Creates a rate limit middleware for the specified tier.
 *
 * @param tier - Rate limit tier (anonymous, user, admin, seed)
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * // Apply to all API routes
 * app.use('/api/', createRateLimiter('anonymous'));
 *
 * // Apply higher limit to authenticated routes
 * app.use('/api/admin/', requireAuth, createRateLimiter('admin'));
 * ```
 */
export function createRateLimiter(tier: string) {
  const config = RATE_LIMIT_TIERS[tier] || RATE_LIMIT_TIERS.anonymous;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = getRateLimitKey(req, tier);

    try {
      const result = await checkRateLimit(key, config.limit, config.windowSeconds);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', config.limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
      res.setHeader('X-RateLimit-Reset', result.resetTime);

      if (!result.allowed) {
        rateLimitHitsCounter.labels(tier).inc();
        logger.warn(
          { tier, key, limit: config.limit },
          'Rate limit exceeded'
        );

        res.status(429).json({
          error: 'Too Many Requests',
          message: config.message,
          retryAfter: config.windowSeconds,
        });
        return;
      }

      next();
    } catch (error) {
      // On Redis error, allow request but log warning
      logger.error({ err: error, tier }, 'Rate limit check error');
      next();
    }
  };
}

/**
 * Creates a tiered rate limiter that adjusts limits based on user role.
 *
 * Automatically selects the appropriate tier based on session role:
 * - No session: anonymous tier
 * - USER role: user tier
 * - ADMIN role: admin tier
 *
 * @returns Express middleware function
 */
export function createTieredRateLimiter() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Determine tier based on authentication
    let tier: string;
    if (!req.session?.userId) {
      tier = 'anonymous';
    } else if (req.session.role === UserRole.ADMIN) {
      tier = 'admin';
    } else {
      tier = 'user';
    }

    const config = RATE_LIMIT_TIERS[tier];
    const key = getRateLimitKey(req, tier);

    try {
      const result = await checkRateLimit(key, config.limit, config.windowSeconds);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', config.limit);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
      res.setHeader('X-RateLimit-Reset', result.resetTime);

      if (!result.allowed) {
        rateLimitHitsCounter.labels(tier).inc();
        logger.warn(
          { tier, key, limit: config.limit, userId: req.session?.userId },
          'Rate limit exceeded'
        );

        res.status(429).json({
          error: 'Too Many Requests',
          message: config.message,
          retryAfter: config.windowSeconds,
        });
        return;
      }

      next();
    } catch (error) {
      logger.error({ err: error, tier }, 'Rate limit check error');
      next();
    }
  };
}

/**
 * Rate limiter specifically for seed URL injection.
 *
 * Seed injection has a special low limit because:
 * 1. Each seed can spawn thousands of crawl jobs
 * 2. Prevents accidental or malicious frontier flooding
 * 3. Gives admins time to verify seeds are working as expected
 */
export const seedInjectionLimiter = createRateLimiter('seed');

/**
 * Clears rate limit for a specific key.
 * Useful for testing or administrative override.
 */
export async function clearRateLimit(tier: string, identifier: string): Promise<void> {
  const key = `crawler:ratelimit:${tier}:${identifier}`;
  await redis.del(key);
  logger.info({ tier, identifier }, 'Rate limit cleared');
}

/**
 * Gets current rate limit status for debugging.
 */
export async function getRateLimitStatus(
  tier: string,
  identifier: string
): Promise<{ count: number; limit: number; windowSeconds: number }> {
  const key = `crawler:ratelimit:${tier}:${identifier}`;
  const config = RATE_LIMIT_TIERS[tier] || RATE_LIMIT_TIERS.anonymous;

  const windowStart = Date.now() - config.windowSeconds * 1000;
  await redis.zremrangebyscore(key, 0, windowStart);
  const count = await redis.zcard(key);

  return {
    count,
    limit: config.limit,
    windowSeconds: config.windowSeconds,
  };
}
