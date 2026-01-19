import Redis from 'ioredis';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import redis from '../redis.js';
import { createLogger } from './logger.js';
import { rateLimitExceeded } from './metrics.js';

const logger = createLogger('rate-limiter');

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter?: number;
}

interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  keyGenerator: (req: Request) => string;
  endpoint?: string;
}

interface AuthenticatedRequest extends Request {
  user?: { id: string; [key: string]: unknown };
}

/**
 * Rate limiter using Redis sliding window algorithm
 */
export class RateLimiter {
  private redis: Redis;
  private keyPrefix: string;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    this.keyPrefix = 'ratelimit:';
  }

  /**
   * Check if a request is allowed under the rate limit
   */
  async checkLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const fullKey = `${this.keyPrefix}${key}`;
    const now = Date.now();
    const windowStart = now - (windowSeconds * 1000);

    try {
      // Use a transaction for atomic operations
      const pipeline = this.redis.pipeline();

      // Remove old entries outside the window
      pipeline.zremrangebyscore(fullKey, 0, windowStart);

      // Count current entries in the window
      pipeline.zcard(fullKey);

      // Execute the pipeline
      const results = await pipeline.exec();

      // Get the current count after removing old entries
      const currentCount = results?.[1]?.[1] as number ?? 0;

      if (currentCount >= limit) {
        // Get the oldest entry to calculate retry-after
        const oldestEntry = await this.redis.zrange(fullKey, 0, 0, 'WITHSCORES');
        const oldestTimestamp = oldestEntry.length >= 2 ? parseInt(oldestEntry[1]) : now;
        const retryAfter = Math.ceil((oldestTimestamp + (windowSeconds * 1000) - now) / 1000);

        logger.debug({
          key,
          currentCount,
          limit,
          retryAfter,
        }, 'Rate limit exceeded');

        return {
          allowed: false,
          remaining: 0,
          retryAfter: Math.max(1, retryAfter),
        };
      }

      // Add the current request
      await this.redis.zadd(fullKey, now, `${now}:${Math.random()}`);

      // Set expiry on the key
      await this.redis.expire(fullKey, windowSeconds);

      return {
        allowed: true,
        remaining: limit - currentCount - 1,
      };
    } catch (error) {
      logger.error({ error, key }, 'Rate limit check failed');
      // Fail open - allow the request if Redis is down
      return { allowed: true, remaining: limit };
    }
  }

  /**
   * Create Express middleware for rate limiting
   */
  middleware(options: RateLimitOptions): RequestHandler {
    const { limit, windowSeconds, keyGenerator, endpoint = 'unknown' } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const key = keyGenerator(req);
      const result = await this.checkLimit(key, limit, windowSeconds);

      // Set rate limit headers
      res.setHeader('X-RateLimit-Limit', limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Window', windowSeconds);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter!);
        res.setHeader('X-RateLimit-Reset', Date.now() + (result.retryAfter! * 1000));

        // Record metric
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.user?.id || 'anonymous';
        rateLimitExceeded.inc({ endpoint, user_id: userId });

        logger.warn({
          userId,
          endpoint,
          key,
          retryAfter: result.retryAfter,
        }, 'Rate limit exceeded');

        res.status(429).json({
          error: 'Too Many Requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter: result.retryAfter,
        });
        return;
      }

      next();
    };
  }
}

// Create singleton instance
const rateLimiter = new RateLimiter(redis);

// Pre-configured rate limiters for common use cases
export const messageRateLimiter = rateLimiter.middleware({
  limit: 60,
  windowSeconds: 60,
  keyGenerator: (req) => `messages:${(req as AuthenticatedRequest).user!.id}`,
  endpoint: 'messages',
});

export const messageAttachmentRateLimiter = rateLimiter.middleware({
  limit: 20,
  windowSeconds: 60,
  keyGenerator: (req) => `attachments:${(req as AuthenticatedRequest).user!.id}`,
  endpoint: 'attachments',
});

export const loginRateLimiter = rateLimiter.middleware({
  limit: 5,
  windowSeconds: 900, // 15 minutes
  keyGenerator: (req) => `login:${req.ip}`,
  endpoint: 'login',
});

export const deviceRegistrationRateLimiter = rateLimiter.middleware({
  limit: 10,
  windowSeconds: 3600, // 1 hour
  keyGenerator: (req) => `device:${(req as AuthenticatedRequest).user!.id}`,
  endpoint: 'device_registration',
});

export const keysRateLimiter = rateLimiter.middleware({
  limit: 100,
  windowSeconds: 60,
  keyGenerator: (req) => `keys:${(req as AuthenticatedRequest).user!.id}`,
  endpoint: 'keys',
});

export default rateLimiter;
