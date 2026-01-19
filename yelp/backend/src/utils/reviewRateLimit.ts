import { redis } from './redis.js';
import { logger } from './logger.js';
import { rateLimitedRequestsTotal } from './metrics.js';
import type { Request, Response, NextFunction } from 'express';

/**
 * Rate Limiting Module for Reviews
 *
 * Implements rate limiting specifically for review operations:
 * - User-based limits: Max reviews per user per time window
 * - IP-based limits: Fallback for unauthenticated detection
 * - Business-specific limits: Prevent review bombing
 *
 * Uses a sliding window counter algorithm in Redis for accuracy.
 */

// Extended request interface
interface RateLimitRequest extends Request {
  user?: {
    id: string;
    [key: string]: unknown;
  };
}

// Rate limit config interface
interface RateLimitConfig {
  points: number;
  duration: number;
  keyPrefix: string;
}

// Rate limit result interface
interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

// Rate limit check result interface
interface RateLimitCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

// Can review result interface
interface CanReviewResult {
  allowed: boolean;
  message?: string;
}

// Rate limit configurations
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Max 10 reviews per user per hour
  userReviews: {
    points: 10,
    duration: 3600, // 1 hour
    keyPrefix: 'ratelimit:reviews:user:',
  },
  // Max 20 review-related actions per IP per hour
  ipReviews: {
    points: 20,
    duration: 3600, // 1 hour
    keyPrefix: 'ratelimit:reviews:ip:',
  },
  // Max 2 reviews per user per business per day
  userBusinessReviews: {
    points: 2,
    duration: 86400, // 24 hours
    keyPrefix: 'ratelimit:reviews:user_business:',
  },
  // Max 5 votes per user per minute
  userVotes: {
    points: 5,
    duration: 60, // 1 minute
    keyPrefix: 'ratelimit:votes:user:',
  },
};

/**
 * Consume a rate limit point
 */
async function consumePoint(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = now - config.duration * 1000;

  try {
    // Use Redis multi for atomic operations
    const multi = redis.multi();

    // Remove old entries outside the window
    multi.zremrangebyscore(key, 0, windowStart);

    // Count current entries
    multi.zcard(key);

    // Add current request
    multi.zadd(key, now, `${now}-${Math.random()}`);

    // Set expiry
    multi.expire(key, config.duration);

    const results = await multi.exec();
    const currentCount = (results?.[1]?.[1] as number) ?? 0; // zcard result

    if (currentCount >= config.points) {
      // Rate limit exceeded
      const oldestEntry = await redis.zrange(key, 0, 0, 'WITHSCORES');
      const resetAt =
        oldestEntry.length > 1
          ? parseInt(oldestEntry[1], 10) + config.duration * 1000
          : now + config.duration * 1000;

      return {
        allowed: false,
        remaining: 0,
        resetAt,
        limit: config.points,
      };
    }

    return {
      allowed: true,
      remaining: config.points - currentCount - 1,
      resetAt: now + config.duration * 1000,
      limit: config.points,
    };
  } catch (error) {
    logger.error(
      { component: 'ratelimit', key, error: (error as Error).message },
      'Rate limit check failed'
    );
    // Fail open - allow request if Redis fails
    return {
      allowed: true,
      remaining: config.points,
      resetAt: now,
      limit: config.points,
    };
  }
}

/**
 * Check rate limit without consuming
 */
async function checkLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitCheckResult> {
  const now = Date.now();
  const windowStart = now - config.duration * 1000;

  try {
    await redis.zremrangebyscore(key, 0, windowStart);
    const count = await redis.zcard(key);

    return {
      allowed: count < config.points,
      remaining: Math.max(0, config.points - count),
      limit: config.points,
    };
  } catch {
    return { allowed: true, remaining: config.points, limit: config.points };
  }
}

/**
 * Rate limit middleware for review creation
 */
export function reviewRateLimit(
  req: RateLimitRequest,
  res: Response,
  next: NextFunction
): void {
  rateLimitMiddleware('userReviews', (r: RateLimitRequest) => r.user?.id)(
    req,
    res,
    next
  );
}

/**
 * Rate limit middleware for review votes
 */
export function voteRateLimit(
  req: RateLimitRequest,
  res: Response,
  next: NextFunction
): void {
  rateLimitMiddleware('userVotes', (r: RateLimitRequest) => r.user?.id)(
    req,
    res,
    next
  );
}

/**
 * Generic rate limit middleware factory
 */
export function rateLimitMiddleware(
  limitType: string,
  keyExtractor: (req: RateLimitRequest) => string | undefined
): (req: RateLimitRequest, res: Response, next: NextFunction) => Promise<void | Response> {
  const config = RATE_LIMITS[limitType];

  if (!config) {
    throw new Error(`Unknown rate limit type: ${limitType}`);
  }

  return async (
    req: RateLimitRequest,
    res: Response,
    next: NextFunction
  ): Promise<void | Response> => {
    const identifier = keyExtractor(req);

    if (!identifier) {
      // Fall back to IP-based limiting
      const ip = req.ip || req.socket?.remoteAddress;
      const ipConfig = RATE_LIMITS.ipReviews;
      const ipKey = `${ipConfig.keyPrefix}${ip}`;
      const result = await consumePoint(ipKey, ipConfig);

      if (!result.allowed) {
        rateLimitedRequestsTotal.inc({ endpoint: req.path, limit_type: 'ip' });
        logger.warn(
          { component: 'ratelimit', ip, path: req.path },
          'IP rate limit exceeded'
        );

        res.set('X-RateLimit-Limit', String(result.limit));
        res.set('X-RateLimit-Remaining', '0');
        res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
        res.set(
          'Retry-After',
          String(Math.ceil((result.resetAt - Date.now()) / 1000))
        );

        return res.status(429).json({
          error: {
            message: 'Too many requests. Please try again later.',
            retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
          },
        });
      }

      res.set('X-RateLimit-Limit', String(result.limit));
      res.set('X-RateLimit-Remaining', String(result.remaining));
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

      return next();
    }

    const key = `${config.keyPrefix}${identifier}`;
    const result = await consumePoint(key, config);

    if (!result.allowed) {
      rateLimitedRequestsTotal.inc({
        endpoint: req.path,
        limit_type: limitType,
      });
      logger.warn(
        { component: 'ratelimit', userId: identifier, limitType, path: req.path },
        'User rate limit exceeded'
      );

      res.set('X-RateLimit-Limit', String(result.limit));
      res.set('X-RateLimit-Remaining', '0');
      res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
      res.set(
        'Retry-After',
        String(Math.ceil((result.resetAt - Date.now()) / 1000))
      );

      return res.status(429).json({
        error: {
          message:
            'You have exceeded the rate limit for this action. Please try again later.',
          retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
        },
      });
    }

    res.set('X-RateLimit-Limit', String(result.limit));
    res.set('X-RateLimit-Remaining', String(result.remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));

    next();
  };
}

/**
 * Check if user can review a specific business (prevents review bombing)
 */
export async function canReviewBusiness(
  userId: string,
  businessId: string
): Promise<CanReviewResult> {
  const config = RATE_LIMITS.userBusinessReviews;
  const key = `${config.keyPrefix}${userId}:${businessId}`;
  const result = await checkLimit(key, config);

  if (!result.allowed) {
    return {
      allowed: false,
      message:
        'You have reached the maximum number of reviews for this business today.',
    };
  }

  return { allowed: true };
}

/**
 * Record a review action for rate limiting
 */
export async function recordReviewAction(
  userId: string,
  businessId: string
): Promise<void> {
  const config = RATE_LIMITS.userBusinessReviews;
  const key = `${config.keyPrefix}${userId}:${businessId}`;
  await consumePoint(key, config);
}

/**
 * Reset rate limit for a user (admin function)
 */
export async function resetRateLimit(
  limitType: string,
  identifier: string
): Promise<void> {
  const config = RATE_LIMITS[limitType];
  if (!config) return;

  const key = `${config.keyPrefix}${identifier}`;
  await redis.del(key);

  logger.info(
    { component: 'ratelimit', limitType, identifier },
    'Rate limit reset'
  );
}

export default {
  reviewRateLimit,
  voteRateLimit,
  rateLimitMiddleware,
  canReviewBusiness,
  recordReviewAction,
  resetRateLimit,
};
