import { Request, Response, NextFunction, RequestHandler } from 'express';
import redis, { RedisClient } from '../redis.js';
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
 * Sliding-window log in one atomic step. The previous version counted with
 * ZCARD and added with a separate ZADD, so concurrent requests could all see
 * "59 of 60" and all be admitted. Running trim, count and add inside one Lua
 * script makes the check-and-record indivisible on the Redis server.
 *
 * KEYS[1] = window key; ARGV = now (ms), window (ms), limit, unique member.
 * Returns {allowed (1|0), count after this request, oldest score in window}.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, tonumber(oldest[2]) or now}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, count + 1, now}
`;

/**
 * Rate limiter using a Redis sliding window, shared by every server instance
 */
export class RateLimiter {
  private redis: RedisClient;
  private keyPrefix: string;

  constructor(redisClient: RedisClient) {
    this.redis = redisClient;
    this.keyPrefix = 'ratelimit:';
  }

  /**
   * Check if a request is allowed under the rate limit, and record it if so
   */
  async checkLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const fullKey = `${this.keyPrefix}${key}`;
    const now = Date.now();
    const windowMs = windowSeconds * 1000;

    try {
      const [allowed, count, oldest] = (await this.redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        fullKey,
        now,
        windowMs,
        limit,
        `${now}:${Math.random().toString(36).slice(2)}`
      )) as [number, number, number];

      if (allowed !== 1) {
        const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        logger.debug({ key, count, limit, retryAfter }, 'Rate limit exceeded');
        return { allowed: false, remaining: 0, retryAfter };
      }

      return { allowed: true, remaining: Math.max(0, limit - count) };
    } catch (error) {
      logger.error({ error, key }, 'Rate limit check failed');
      // Fail open - delivering messages matters more than enforcing limits
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

      // IETF RateLimit header fields (draft-ietf-httpapi-ratelimit-headers)
      res.setHeader('RateLimit-Limit', limit);
      res.setHeader('RateLimit-Remaining', result.remaining);
      res.setHeader('RateLimit-Reset', result.allowed ? windowSeconds : result.retryAfter!);

      if (!result.allowed) {
        res.setHeader('Retry-After', result.retryAfter!);

        // Record metric (per endpoint only; the user goes to the log)
        const authReq = req as AuthenticatedRequest;
        const userId = authReq.user?.id || 'anonymous';
        rateLimitExceeded.inc({ endpoint });

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
/** Message sends per user, shared by the REST route and the WebSocket path. */
export const MESSAGE_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;
export const messageRateKey = (userId: string): string => `messages:${userId}`;

export const messageRateLimiter = rateLimiter.middleware({
  ...MESSAGE_RATE_LIMIT,
  keyGenerator: (req) => messageRateKey((req as AuthenticatedRequest).user!.id),
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
