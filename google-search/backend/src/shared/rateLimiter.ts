import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { Request, Response } from 'express';
import { redis } from '../models/redis.js';
import { logger } from './logger.js';
import { rateLimitRejectionsCounter } from './metrics.js';
import { config } from '../config/index.js';

/**
 * Rate Limiting Module
 *
 * WHY rate limiting prevents resource exhaustion:
 * - Protect Elasticsearch from query storms
 * - Prevent individual clients from monopolizing resources
 * - Maintain fair access for all users
 * - Guard against simple DoS attacks
 * - Preserve system stability during traffic spikes
 */

interface IncrementResult {
  totalHits: number;
  resetTime: Date;
}

/**
 * Custom Redis store for rate limiting (distributed rate limiting)
 */
class RedisRateLimitStore {
  prefix: string;
  windowMs: number;

  constructor(options: { prefix?: string; windowMs?: number } = {}) {
    this.prefix = options.prefix || 'rl:';
    this.windowMs = options.windowMs || 60000;
  }

  async increment(key: string): Promise<IncrementResult> {
    const redisKey = `${this.prefix}${key}`;

    try {
      const multi = redis.multi();
      multi.incr(redisKey);
      multi.pttl(redisKey);
      const results = await multi.exec();

      if (!results) {
        return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
      }

      const totalHits = results[0][1] as number;
      const pttl = results[1][1] as number;

      // Set expiry if this is a new key
      if (pttl === -1) {
        await redis.pexpire(redisKey, this.windowMs);
      }

      return {
        totalHits,
        resetTime: new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs)),
      };
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Redis rate limit store error');
      // Fall back to allowing the request on Redis failure
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    try {
      await redis.decr(redisKey);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Redis rate limit decrement error');
    }
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    try {
      await redis.del(redisKey);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Redis rate limit reset error');
    }
  }
}

/**
 * Rate limiter for search queries
 * More restrictive - protects expensive Elasticsearch operations
 */
export const searchRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: config.rateLimit?.searchWindowMs || 60 * 1000, // 1 minute
  max: config.rateLimit?.searchMaxRequests || 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:search:',
    windowMs: config.rateLimit?.searchWindowMs || 60 * 1000,
  }),
  keyGenerator: (req: Request): string => {
    // Rate limit by IP, or by API key if provided
    return (req.headers['x-api-key'] as string) || req.ip || 'unknown';
  },
  handler: (req: Request, res: Response, _next, options): void => {
    rateLimitRejectionsCounter.labels('search').inc();
    logger.warn(
      {
        event: 'rate_limit_exceeded',
        endpoint: 'search',
        ip: req.ip,
        limit: options.max,
      },
      'Search rate limit exceeded'
    );
    res.status(429).json({
      error: 'Too many search requests',
      message: `Rate limit exceeded. Maximum ${options.max} requests per minute.`,
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
  skip: (req: Request): boolean => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

/**
 * Rate limiter for autocomplete
 * Less restrictive - autocomplete is cheaper and needs to feel responsive
 */
export const autocompleteRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: config.rateLimit?.autocompleteWindowMs || 60 * 1000,
  max: config.rateLimit?.autocompleteMaxRequests || 120, // 2 per second
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:autocomplete:',
    windowMs: config.rateLimit?.autocompleteWindowMs || 60 * 1000,
  }),
  keyGenerator: (req: Request): string => (req.headers['x-api-key'] as string) || req.ip || 'unknown',
  handler: (req: Request, res: Response, _next, options): void => {
    rateLimitRejectionsCounter.labels('autocomplete').inc();
    res.status(429).json({
      error: 'Too many autocomplete requests',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
});

/**
 * Rate limiter for admin operations
 * Very restrictive - admin operations are expensive
 */
export const adminRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: config.rateLimit?.adminWindowMs || 60 * 1000,
  max: config.rateLimit?.adminMaxRequests || 10, // 10 per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:admin:',
    windowMs: config.rateLimit?.adminWindowMs || 60 * 1000,
  }),
  keyGenerator: (req: Request): string => req.ip || 'unknown',
  handler: (req: Request, res: Response, _next, options): void => {
    rateLimitRejectionsCounter.labels('admin').inc();
    logger.warn(
      {
        event: 'rate_limit_exceeded',
        endpoint: 'admin',
        ip: req.ip,
      },
      'Admin rate limit exceeded'
    );
    res.status(429).json({
      error: 'Too many admin requests',
      message: 'Please wait before making more admin requests.',
      retryAfter: Math.ceil(options.windowMs / 1000),
    });
  },
});

/**
 * Global rate limiter - last line of defense
 */
export const globalRateLimiter: RateLimitRequestHandler = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit?.globalMaxRequests || 200, // 200 total requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => req.ip || 'unknown',
  handler: (req: Request, res: Response): void => {
    rateLimitRejectionsCounter.labels('global').inc();
    logger.warn(
      {
        event: 'global_rate_limit_exceeded',
        ip: req.ip,
      },
      'Global rate limit exceeded'
    );
    res.status(429).json({
      error: 'Too many requests',
      message: 'Please slow down.',
    });
  },
  skip: (req: Request): boolean => req.path === '/health' || req.path === '/metrics',
});
