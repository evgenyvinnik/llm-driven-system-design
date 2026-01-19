import rateLimit, { RateLimitRequestHandler, Options } from 'express-rate-limit';
import { Request, Response } from 'express';
import { redis } from '../services/redis.js';
import { rateLimitHits } from './metrics.js';
import { logger } from './logger.js';

/**
 * Rate limiting module using Redis-backed sliding window.
 *
 * Benefits:
 * - Prevents abuse and ensures fair resource usage
 * - Redis backing enables distributed rate limiting across instances
 * - Different limits for different endpoint categories
 * - Protects expensive operations (search, streaming) separately
 *
 * Trade-off: Redis-backed vs in-memory
 * - Redis: Consistent across instances, survives restarts
 * - In-memory: Lower latency, no external dependency
 * Chosen: Redis for production-grade distributed limiting
 */

interface IncrementResult {
  totalHits: number;
  resetTime: Date;
}

/**
 * Custom Redis store for express-rate-limit.
 * Uses Redis INCR with EXPIRE for atomic sliding window.
 */
class RedisRateLimitStore {
  prefix: string;
  windowSeconds: number;

  constructor(prefix: string, windowMs: number) {
    this.prefix = prefix;
    this.windowSeconds = Math.ceil(windowMs / 1000);
  }

  async increment(key: string): Promise<IncrementResult> {
    const redisKey = `${this.prefix}:${key}`;
    try {
      const current = await redis.incr(redisKey);
      // Set expiry only on first increment
      if (current === 1) {
        await redis.expire(redisKey, this.windowSeconds);
      }
      const ttl = await redis.ttl(redisKey);
      return {
        totalHits: current,
        resetTime: new Date(Date.now() + ttl * 1000)
      };
    } catch (err) {
      logger.error({ err, key: redisKey }, 'Redis rate limit increment failed');
      // Fail open - allow request on Redis error
      return { totalHits: 0, resetTime: new Date() };
    }
  }

  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}:${key}`;
    try {
      await redis.decr(redisKey);
    } catch (err) {
      logger.error({ err, key: redisKey }, 'Redis rate limit decrement failed');
    }
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = `${this.prefix}:${key}`;
    try {
      await redis.del(redisKey);
    } catch (err) {
      logger.error({ err, key: redisKey }, 'Redis rate limit reset failed');
    }
  }
}

interface LimiterOptions {
  prefix: string;
  windowMs: number;
  max: number;
  category: string;
  message?: string;
  keyGenerator?: (req: Request) => string;
}

/**
 * Create a rate limiter with specified configuration.
 */
function createLimiter(options: LimiterOptions): RateLimitRequestHandler {
  const {
    prefix,
    windowMs,
    max,
    category,
    message,
    keyGenerator
  } = options;

  const rateLimitOptions: Partial<Options> = {
    windowMs,
    max,
    message: { error: message || 'Too many requests, please slow down' },
    standardHeaders: true, // Return rate limit info in headers
    legacyHeaders: false,
    store: new RedisRateLimitStore(prefix, windowMs) as unknown as Options['store'],
    // Disable IP-based validation warnings since we use custom keyGenerator with user ID fallback
    validate: { ip: false, keyGeneratorIpFallback: false },
    keyGenerator: keyGenerator || ((req: Request): string => {
      // Use user ID if authenticated, otherwise IP
      return req.user?.id || req.ip || (req.connection as { remoteAddress?: string })?.remoteAddress || 'unknown';
    }),
    handler: (req: Request, res: Response, _next, opts): void => {
      // Track rate limit hits in metrics
      rateLimitHits.inc({ category });
      logger.warn({
        userId: req.user?.id,
        ip: req.ip,
        path: req.path,
        category
      }, 'Rate limit exceeded');
      res.status(429).json(opts.message);
    },
    // Skip rate limiting for health checks
    skip: (req: Request): boolean => req.path === '/health' || req.path === '/metrics'
  };

  return rateLimit(rateLimitOptions);
}

/**
 * Global rate limiter - applies to all API endpoints.
 * 100 requests per minute per user/IP.
 */
export const globalLimiter = createLimiter({
  prefix: 'rl:global',
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  category: 'global',
  message: 'Too many requests, please slow down'
});

/**
 * Streaming rate limiter - more generous for playback.
 * 300 requests per minute per user (for segment fetching).
 */
export const streamLimiter = createLimiter({
  prefix: 'rl:stream',
  windowMs: 60 * 1000,
  max: 300,
  category: 'stream',
  message: 'Too many stream requests'
});

/**
 * Search rate limiter - protects expensive search operations.
 * 30 searches per minute per user.
 */
export const searchLimiter = createLimiter({
  prefix: 'rl:search',
  windowMs: 60 * 1000,
  max: 30,
  category: 'search',
  message: 'Too many search requests, please wait'
});

/**
 * Admin rate limiter - stricter limits for admin operations.
 * 50 requests per minute per admin user.
 */
export const adminLimiter = createLimiter({
  prefix: 'rl:admin',
  windowMs: 60 * 1000,
  max: 50,
  category: 'admin',
  message: 'Admin rate limit exceeded'
});

/**
 * Login rate limiter - protects against brute force.
 * 5 attempts per 15 minutes per IP.
 */
export const loginLimiter = createLimiter({
  prefix: 'rl:login',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  category: 'login',
  message: 'Too many login attempts, please try again later',
  keyGenerator: (req: Request): string => req.ip || (req.connection as { remoteAddress?: string })?.remoteAddress || 'unknown'
});

/**
 * Playlist creation rate limiter - prevents spam.
 * 10 playlists per hour per user.
 */
export const playlistCreateLimiter = createLimiter({
  prefix: 'rl:playlist_create',
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  category: 'playlist_create',
  message: 'Playlist creation limit reached, please wait'
});

export default {
  globalLimiter,
  streamLimiter,
  searchLimiter,
  adminLimiter,
  loginLimiter,
  playlistCreateLimiter
};
