/**
 * Rate limiting middleware using Redis token bucket algorithm.
 * Provides per-user rate limiting with configurable limits by category.
 *
 * @module utils/rateLimiter
 */
import { Request, Response, NextFunction } from 'express';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { rateLimitHitsTotal } from './metrics.js';

/**
 * Rate limit configuration by category.
 */
export interface RateLimitConfig {
  requestsPerMinute: number;
  burstSize: number;
  refillRate: number; // tokens per second
}

/**
 * Rate limit configurations for different endpoint categories.
 */
export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Public endpoints (login, register)
  public: {
    requestsPerMinute: 10,
    burstSize: 10,
    refillRate: 1 / 6, // 1 token every 6 seconds
  },
  // Authenticated read operations
  read: {
    requestsPerMinute: 100,
    burstSize: 100,
    refillRate: 100 / 60, // ~1.67 tokens per second
  },
  // Authenticated write operations
  write: {
    requestsPerMinute: 30,
    burstSize: 30,
    refillRate: 0.5, // 1 token every 2 seconds
  },
  // Connection requests (more restricted to prevent spam)
  connectionRequest: {
    requestsPerMinute: 20,
    burstSize: 10,
    refillRate: 20 / 60, // ~0.33 tokens per second
  },
  // Search operations
  search: {
    requestsPerMinute: 20,
    burstSize: 20,
    refillRate: 20 / 60, // ~0.33 tokens per second
  },
  // Admin endpoints
  admin: {
    requestsPerMinute: 60,
    burstSize: 60,
    refillRate: 1, // 1 token per second
  },
};

/**
 * Rate limit result.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  limit: number;
}

/**
 * Token bucket rate limiter using Redis.
 * Implements sliding window rate limiting with burst capacity.
 *
 * @param identifier - Unique identifier (userId, IP, etc.)
 * @param category - Rate limit category
 * @returns Rate limit result
 */
export async function checkRateLimit(
  identifier: string,
  category: string
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[category] || RATE_LIMITS.read;
  const key = `ratelimit:${category}:${identifier}`;
  const now = Date.now();

  try {
    // Use Lua script for atomic token bucket operation
    const script = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local burst = tonumber(ARGV[2])
      local refill = tonumber(ARGV[3])
      local window = 60000 -- 1 minute in ms

      local bucket = redis.call('HMGET', key, 'tokens', 'lastUpdate')
      local tokens = tonumber(bucket[1]) or burst
      local lastUpdate = tonumber(bucket[2]) or now

      -- Calculate tokens to add based on time elapsed
      local elapsed = (now - lastUpdate) / 1000 -- in seconds
      local tokensToAdd = elapsed * refill
      tokens = math.min(burst, tokens + tokensToAdd)

      -- Check if request is allowed
      local allowed = 0
      if tokens >= 1 then
        tokens = tokens - 1
        allowed = 1
      end

      -- Update bucket
      redis.call('HMSET', key, 'tokens', tokens, 'lastUpdate', now)
      redis.call('PEXPIRE', key, window)

      -- Calculate reset time (when tokens will be full again)
      local tokensNeeded = burst - tokens
      local resetTime = now + (tokensNeeded / refill * 1000)

      return {allowed, math.floor(tokens), math.floor(resetTime)}
    `;

    const result = await redis.eval(
      script,
      1,
      key,
      now.toString(),
      config.burstSize.toString(),
      config.refillRate.toString()
    ) as [number, number, number];

    const [allowed, remaining, resetTime] = result;

    return {
      allowed: allowed === 1,
      remaining,
      resetTime,
      limit: config.requestsPerMinute,
    };
  } catch (error) {
    logger.error({ error, identifier, category }, 'Rate limit check failed');
    // Fail open - allow request if Redis is down
    return {
      allowed: true,
      remaining: config.requestsPerMinute,
      resetTime: now + 60000,
      limit: config.requestsPerMinute,
    };
  }
}

/**
 * Sets rate limit headers on the response.
 *
 * @param res - Express response object
 * @param result - Rate limit result
 */
function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, result.remaining));
  res.setHeader('X-RateLimit-Reset', Math.floor(result.resetTime / 1000));
}

/**
 * Creates a rate limiting middleware for a specific category.
 *
 * @param category - Rate limit category
 * @param identifierFn - Function to extract identifier from request
 * @returns Express middleware
 */
export function rateLimit(
  category: string,
  identifierFn?: (req: Request) => string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Get identifier (user ID if authenticated, IP if not)
    const identifier = identifierFn
      ? identifierFn(req)
      : req.session?.userId?.toString() || req.ip || 'anonymous';

    const result = await checkRateLimit(identifier, category);
    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      rateLimitHitsTotal.inc({ category });
      logger.warn({ identifier, category, remaining: result.remaining }, 'Rate limit exceeded');

      res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((result.resetTime - Date.now()) / 1000),
      });
      return;
    }

    next();
  };
}

/**
 * Rate limiter for public endpoints (login, register).
 * Uses IP address as identifier.
 */
export const publicRateLimit = rateLimit('public', (req) => req.ip || 'anonymous');

/**
 * Rate limiter for read operations.
 */
export const readRateLimit = rateLimit('read');

/**
 * Rate limiter for write operations.
 */
export const writeRateLimit = rateLimit('write');

/**
 * Rate limiter for connection requests (stricter limit).
 */
export const connectionRequestRateLimit = rateLimit('connectionRequest');

/**
 * Rate limiter for search operations.
 */
export const searchRateLimit = rateLimit('search');

/**
 * Rate limiter for admin operations.
 */
export const adminRateLimit = rateLimit('admin');

export default rateLimit;
