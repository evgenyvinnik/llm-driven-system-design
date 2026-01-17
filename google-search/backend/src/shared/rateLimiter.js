import rateLimit from 'express-rate-limit';
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

/**
 * Custom Redis store for rate limiting (distributed rate limiting)
 */
class RedisRateLimitStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'rl:';
    this.windowMs = options.windowMs || 60000;
  }

  async increment(key) {
    const redisKey = `${this.prefix}${key}`;

    try {
      const multi = redis.multi();
      multi.incr(redisKey);
      multi.pttl(redisKey);
      const results = await multi.exec();

      const totalHits = results[0][1];
      const pttl = results[1][1];

      // Set expiry if this is a new key
      if (pttl === -1) {
        await redis.pexpire(redisKey, this.windowMs);
      }

      return {
        totalHits,
        resetTime: new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs)),
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis rate limit store error');
      // Fall back to allowing the request on Redis failure
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    const redisKey = `${this.prefix}${key}`;
    try {
      await redis.decr(redisKey);
    } catch (error) {
      logger.error({ error: error.message }, 'Redis rate limit decrement error');
    }
  }

  async resetKey(key) {
    const redisKey = `${this.prefix}${key}`;
    try {
      await redis.del(redisKey);
    } catch (error) {
      logger.error({ error: error.message }, 'Redis rate limit reset error');
    }
  }
}

/**
 * Rate limiter for search queries
 * More restrictive - protects expensive Elasticsearch operations
 */
export const searchRateLimiter = rateLimit({
  windowMs: config.rateLimit?.searchWindowMs || 60 * 1000, // 1 minute
  max: config.rateLimit?.searchMaxRequests || 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:search:',
    windowMs: config.rateLimit?.searchWindowMs || 60 * 1000,
  }),
  keyGenerator: (req) => {
    // Rate limit by IP, or by API key if provided
    return req.headers['x-api-key'] || req.ip;
  },
  handler: (req, res, next, options) => {
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
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

/**
 * Rate limiter for autocomplete
 * Less restrictive - autocomplete is cheaper and needs to feel responsive
 */
export const autocompleteRateLimiter = rateLimit({
  windowMs: config.rateLimit?.autocompleteWindowMs || 60 * 1000,
  max: config.rateLimit?.autocompleteMaxRequests || 120, // 2 per second
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:autocomplete:',
    windowMs: config.rateLimit?.autocompleteWindowMs || 60 * 1000,
  }),
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
  handler: (req, res, next, options) => {
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
export const adminRateLimiter = rateLimit({
  windowMs: config.rateLimit?.adminWindowMs || 60 * 1000,
  max: config.rateLimit?.adminMaxRequests || 10, // 10 per minute
  standardHeaders: true,
  legacyHeaders: false,
  store: new RedisRateLimitStore({
    prefix: 'rl:admin:',
    windowMs: config.rateLimit?.adminWindowMs || 60 * 1000,
  }),
  keyGenerator: (req) => req.ip,
  handler: (req, res, next, options) => {
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
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit?.globalMaxRequests || 200, // 200 total requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
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
  skip: (req) => req.path === '/health' || req.path === '/metrics',
});
