/**
 * Rate limiting module for spam prevention and abuse protection.
 *
 * Implements sliding window rate limiting using Redis for distributed limiting
 * across multiple server instances.
 *
 * WHY rate limiting prevents spam:
 * - Protects the messaging pipeline from malicious flooding attacks
 * - Ensures fair resource allocation among users
 * - Prevents a single user from degrading service for others
 * - Reduces infrastructure costs by rejecting excess traffic early
 * - Provides natural backpressure to misbehaving clients
 *
 * Rate limits are configured per endpoint/action:
 * - Message sending: 60 msgs/minute (1/sec sustained, allows bursts)
 * - Typing events: 10/minute (prevents typing indicator spam)
 * - Login attempts: 5/15min (prevents brute force)
 * - Registration: 3/hour (prevents account spam)
 */

import rateLimit from 'express-rate-limit';
import { redis } from '../redis.js';
import { rateLimitHits } from './metrics.js';
import { logger, LogEvents } from './logger.js';

/**
 * Redis-based rate limiter store for distributed limiting.
 * Uses sliding window algorithm for accurate rate limiting.
 */
class RedisRateLimitStore {
  prefix: string;
  windowMs: number;

  constructor(options: { prefix?: string; windowMs: number }) {
    this.prefix = options.prefix || 'rl:';
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<{ totalHits: number; resetTime: Date }> {
    const redisKey = `${this.prefix}${key}`;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Use Redis sorted set for sliding window
    const multi = redis.multi();
    // Remove old entries outside the window
    multi.zremrangebyscore(redisKey, 0, windowStart);
    // Add current request
    multi.zadd(redisKey, now.toString(), `${now}-${Math.random()}`);
    // Count entries in window
    multi.zcard(redisKey);
    // Set expiry
    multi.pexpire(redisKey, this.windowMs);

    const results = await multi.exec();
    const totalHits = (results?.[2]?.[1] as number) || 1;

    return {
      totalHits,
      resetTime: new Date(now + this.windowMs),
    };
  }

  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    // Remove the most recent entry (approximate)
    await redis.zpopmax(redisKey);
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`;
    await redis.del(redisKey);
  }
}

/**
 * Creates a rate limiter for REST API endpoints.
 *
 * @param options - Rate limiting configuration
 * @returns Express middleware for rate limiting
 */
export function createRateLimiter(options: {
  windowMs: number;
  max: number;
  endpoint: string;
  keyGenerator?: (req: any) => string;
  skipFailedRequests?: boolean;
}) {
  const store = new RedisRateLimitStore({
    prefix: `rl:${options.endpoint}:`,
    windowMs: options.windowMs,
  });

  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    // Use Redis store for distributed limiting
    store: {
      increment: async (key: string) => {
        const result = await store.increment(key);
        return result;
      },
      decrement: async (key: string) => {
        await store.decrement(key);
      },
      resetKey: async (key: string) => {
        await store.resetKey(key);
      },
      init: () => {},
    },
    keyGenerator: options.keyGenerator || ((req) => req.session?.userId || req.ip),
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === '/health' || req.path === '/metrics';
    },
    handler: (req, res, next, optionsUsed) => {
      // Track rate limit hits
      rateLimitHits.inc({ endpoint: options.endpoint });

      logger.warn({
        event: LogEvents.RATE_LIMITED,
        endpoint: options.endpoint,
        user_id: req.session?.userId,
        ip: req.ip,
      });

      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil(options.windowMs / 1000),
      });
    },
    skipFailedRequests: options.skipFailedRequests ?? false,
  });
}

/**
 * Rate limiter for message sending (REST fallback).
 * 60 messages per minute per user.
 */
export const messageRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  endpoint: 'message_send',
});

/**
 * Rate limiter for login attempts.
 * 5 attempts per 15 minutes per IP.
 */
export const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  endpoint: 'login',
  keyGenerator: (req) => req.ip,
  skipFailedRequests: false,
});

/**
 * Rate limiter for registration.
 * 3 registrations per hour per IP.
 */
export const registerRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  endpoint: 'register',
  keyGenerator: (req) => req.ip,
});

/**
 * WebSocket rate limiter for message events.
 * Uses in-memory tracking per connection with Redis backup.
 *
 * @param userId - The user sending messages
 * @param action - The action being rate limited
 * @returns Object with allowed status and remaining quota
 */
export async function checkWebSocketRateLimit(
  userId: string,
  action: 'message' | 'typing'
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const limits: Record<string, { max: number; windowMs: number }> = {
    message: { max: 30, windowMs: 10 * 1000 }, // 30 messages per 10 seconds (burst)
    typing: { max: 10, windowMs: 60 * 1000 }, // 10 typing events per minute
  };

  const limit = limits[action];
  const redisKey = `wsrl:${action}:${userId}`;
  const now = Date.now();
  const windowStart = now - limit.windowMs;

  // Clean up old entries and count current window
  const multi = redis.multi();
  multi.zremrangebyscore(redisKey, 0, windowStart);
  multi.zadd(redisKey, now.toString(), `${now}-${Math.random()}`);
  multi.zcard(redisKey);
  multi.pexpire(redisKey, limit.windowMs);

  const results = await multi.exec();
  const count = (results?.[2]?.[1] as number) || 1;

  const allowed = count <= limit.max;
  const remaining = Math.max(0, limit.max - count);

  if (!allowed) {
    logger.warn({
      event: LogEvents.RATE_LIMITED,
      endpoint: `ws_${action}`,
      user_id: userId,
      count,
      max: limit.max,
    });
    rateLimitHits.inc({ endpoint: `ws_${action}` });
  }

  return {
    allowed,
    remaining,
    resetIn: limit.windowMs,
  };
}
