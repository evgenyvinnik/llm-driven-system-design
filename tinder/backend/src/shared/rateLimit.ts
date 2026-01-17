import rateLimit from 'express-rate-limit';
import { Request, Response, NextFunction } from 'express';
import { redis } from '../db/index.js';
import { rateLimitConfig } from './config.js';
import { logger } from './logger.js';
import { rateLimitedRequestsTotal } from './metrics.js';

/**
 * Rate limiting middleware using express-rate-limit with Redis store.
 * Protects the matching algorithm and prevents API abuse.
 */

/**
 * General API rate limiter.
 * Applies to all API endpoints.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: rateLimitConfig.apiRequestsPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    rateLimitedRequestsTotal.inc({ endpoint: 'api' });
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please slow down and try again later.',
      retryAfter: 60,
    });
  },
  keyGenerator: (req: Request) => {
    // Use session userId if available, otherwise use IP
    return req.session?.userId || req.ip || 'unknown';
  },
});

/**
 * Message rate limiter.
 * More restrictive to prevent message spam.
 */
export const messageRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: rateLimitConfig.messagesPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    rateLimitedRequestsTotal.inc({ endpoint: 'messages' });
    res.status(429).json({
      error: 'Too many messages',
      message: 'You are sending messages too quickly. Please wait a moment.',
      retryAfter: 60,
    });
  },
  keyGenerator: (req: Request) => {
    return req.session?.userId || req.ip || 'unknown';
  },
});

/**
 * Redis-based swipe rate limiter.
 * Uses sliding window for accurate rate limiting.
 * Protects the matching algorithm from being overwhelmed.
 *
 * WHY: Rate limiting for swipes is critical because:
 * 1. Protects the matching algorithm from being overwhelmed by rapid swipes
 * 2. Prevents bots from mass-liking users
 * 3. Ensures fair distribution of likes across the user base
 * 4. Reduces database and Redis load from swipe processing
 * 5. Encourages thoughtful swiping behavior (better for match quality)
 */
export async function swipeRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session?.userId;

  if (!userId) {
    next();
    return;
  }

  const windowMs = rateLimitConfig.swipeWindowMinutes * 60 * 1000;
  const maxSwipes = rateLimitConfig.swipesPerWindow;
  const key = `rate_limit:swipe:${userId}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    // Remove old entries outside the window
    await redis.zremrangebyscore(key, 0, windowStart);

    // Count current swipes in window
    const currentCount = await redis.zcard(key);

    if (currentCount >= maxSwipes) {
      rateLimitedRequestsTotal.inc({ endpoint: 'swipe' });
      logger.warn({ userId, currentCount, maxSwipes }, 'Swipe rate limit exceeded');

      // Get oldest entry to calculate retry time
      const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const retryAfter = oldest.length >= 2
        ? Math.ceil((parseInt(oldest[1]) + windowMs - now) / 1000)
        : rateLimitConfig.swipeWindowMinutes * 60;

      res.status(429).json({
        error: 'Swipe rate limit exceeded',
        message: `You can swipe up to ${maxSwipes} times every ${rateLimitConfig.swipeWindowMinutes} minutes.`,
        retryAfter,
        remaining: 0,
        limit: maxSwipes,
      });
      return;
    }

    // Add current request to the window
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.expire(key, rateLimitConfig.swipeWindowMinutes * 60);

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', maxSwipes);
    res.setHeader('X-RateLimit-Remaining', maxSwipes - currentCount - 1);
    res.setHeader('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000));

    next();
  } catch (error) {
    // On Redis error, allow the request but log the error
    logger.error({ error, userId }, 'Rate limiter Redis error');
    next();
  }
}

/**
 * Hourly swipe limiter (additional protection).
 * Separate from window limiter to catch users who slowly accumulate swipes.
 */
export async function hourlySwipeLimiter(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session?.userId;

  if (!userId) {
    next();
    return;
  }

  const key = `rate_limit:swipe_hourly:${userId}`;
  const maxSwipesPerHour = rateLimitConfig.swipesPerHour;

  try {
    const currentCount = await redis.incr(key);

    // Set expiry on first request
    if (currentCount === 1) {
      await redis.expire(key, 3600); // 1 hour
    }

    if (currentCount > maxSwipesPerHour) {
      rateLimitedRequestsTotal.inc({ endpoint: 'swipe_hourly' });
      logger.warn({ userId, currentCount, maxSwipesPerHour }, 'Hourly swipe limit exceeded');

      const ttl = await redis.ttl(key);

      res.status(429).json({
        error: 'Hourly swipe limit exceeded',
        message: `You have reached your hourly limit of ${maxSwipesPerHour} swipes.`,
        retryAfter: ttl > 0 ? ttl : 3600,
        remaining: 0,
        limit: maxSwipesPerHour,
      });
      return;
    }

    next();
  } catch (error) {
    logger.error({ error, userId }, 'Hourly rate limiter Redis error');
    next();
  }
}
