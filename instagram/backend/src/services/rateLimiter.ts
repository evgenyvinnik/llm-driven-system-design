import rateLimit, { RateLimitRequestHandler, Options } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request, Response, NextFunction } from 'express';
import redis from './redis.js';
import logger from './logger.js';
import { rateLimitHits, followsRateLimited } from './metrics.js';

/**
 * Rate Limiting Module
 *
 * Implements sliding window rate limiting using Redis for distributed
 * rate limiting across multiple API server instances.
 *
 * Rate limits prevent:
 * - Follow spam (mass following/unfollowing for engagement manipulation)
 * - Post spam (automated content flooding)
 * - Login brute force attacks
 * - API abuse and scraping
 */

interface ExtendedRequest extends Request {
  session?: {
    userId?: string;
    username?: string;
    role?: string;
    isVerified?: boolean;
  } & Request['session'];
}

interface RateLimiterOptions {
  keyPrefix: string;
  max: number;
  windowMs: number;
  message?: string;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  actionName?: string;
}

/**
 * Create a rate limiter with Redis backend
 */
const createRateLimiter = (options: RateLimiterOptions): RateLimitRequestHandler => {
  const {
    keyPrefix,
    max,
    windowMs,
    message = 'Too many requests, please try again later.',
    skipSuccessfulRequests = false,
    skipFailedRequests = false,
    actionName = 'request',
  } = options;

  return rateLimit({
    store: new RedisStore({
      // Use the existing ioredis client
      sendCommand: (...args: string[]) => redis.call(...args),
      prefix: `ratelimit:${keyPrefix}:`,
    }),
    max,
    windowMs,
    message: { error: message },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    skipSuccessfulRequests,
    skipFailedRequests,
    keyGenerator: (req: ExtendedRequest): string => {
      // Use user ID if authenticated, otherwise IP
      return req.session?.userId || req.ip || 'unknown';
    },
    handler: (
      req: ExtendedRequest,
      res: Response,
      _next: NextFunction,
      opts: Options
    ): void => {
      // Log and track rate limit hits
      const key = req.session?.userId || req.ip;
      logger.warn(
        {
          type: 'rate_limit',
          action: actionName,
          key: key,
          limit: max,
          windowMs,
        },
        `Rate limit exceeded for ${actionName}: ${key}`
      );

      rateLimitHits.labels(actionName).inc();

      const errorMessage =
        typeof opts.message === 'object' && opts.message !== null && 'error' in opts.message
          ? (opts.message as { error: string }).error
          : message;
      res.status(opts.statusCode || 429).json({ error: errorMessage });
    },
  });
};

/**
 * Rate limiter for post creation
 * Prevents content spam - 10 posts per hour
 */
export const postRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'posts',
  max: 10,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'You have reached the post limit. Please wait before posting again.',
  actionName: 'post_create',
});

/**
 * Rate limiter for following users
 * Prevents follow spam - 30 follows per hour
 *
 * WHY: Follow spam is a common engagement manipulation technique where
 * users rapidly follow/unfollow accounts to gain attention. Rate limiting
 * prevents this while allowing normal social interaction patterns.
 */
export const followRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'follows',
  max: 30,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'You are following too many users. Please wait before following more.',
  actionName: 'follow',
});

// Track follow rate limits separately for metrics
export const followRateLimitMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  followRateLimiter(req, res, (err?: unknown) => {
    if (res.headersSent) {
      followsRateLimited.inc();
    }
    next(err);
  });
};

/**
 * Rate limiter for login attempts
 * Prevents brute force attacks - 5 attempts per minute
 */
export const loginRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'login',
  max: 5,
  windowMs: 60 * 1000, // 1 minute
  message: 'Too many login attempts. Please try again later.',
  skipSuccessfulRequests: true, // Only count failed logins
  actionName: 'login',
});

/**
 * Rate limiter for likes
 * Prevents like spam - 100 likes per hour
 */
export const likeRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'likes',
  max: 100,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'You have reached the like limit. Please wait before liking more posts.',
  actionName: 'like',
});

/**
 * Rate limiter for comments
 * Prevents comment spam - 50 comments per hour
 */
export const commentRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'comments',
  max: 50,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'You have reached the comment limit. Please wait before commenting more.',
  actionName: 'comment',
});

/**
 * Rate limiter for story creation
 * Prevents story spam - 20 stories per hour
 */
export const storyRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'stories',
  max: 20,
  windowMs: 60 * 60 * 1000, // 1 hour
  message: 'You have reached the story limit. Please wait before posting more stories.',
  actionName: 'story_create',
});

/**
 * Rate limiter for feed requests
 * Prevents API scraping - 60 requests per minute
 */
export const feedRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'feed',
  max: 60,
  windowMs: 60 * 1000, // 1 minute
  message: 'Too many feed requests. Please slow down.',
  actionName: 'feed',
});

/**
 * General API rate limiter
 * Applies to all endpoints as a catch-all - 1000 requests per minute
 */
export const generalRateLimiter: RateLimitRequestHandler = createRateLimiter({
  keyPrefix: 'general',
  max: 1000,
  windowMs: 60 * 1000, // 1 minute
  message: 'Too many requests. Please slow down.',
  actionName: 'general',
});

/**
 * Custom rate limit check using Redis directly
 * For more flexible rate limiting scenarios
 */
export const checkRateLimit = async (
  userId: string,
  action: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> => {
  const key = `ratelimit:custom:${action}:${userId}`;
  const current = await redis.incr(key);

  if (current === 1) {
    await redis.expire(key, windowSeconds);
  }

  if (current > limit) {
    logger.warn(
      {
        type: 'rate_limit',
        action,
        userId,
        current,
        limit,
      },
      `Custom rate limit exceeded for ${action}: ${userId}`
    );
    rateLimitHits.labels(action).inc();
    return false;
  }

  return true;
};

export default {
  postRateLimiter,
  followRateLimiter,
  followRateLimitMiddleware,
  loginRateLimiter,
  likeRateLimiter,
  commentRateLimiter,
  storyRateLimiter,
  feedRateLimiter,
  generalRateLimiter,
  checkRateLimit,
};
