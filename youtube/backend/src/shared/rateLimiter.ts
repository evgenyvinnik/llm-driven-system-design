import { RateLimiterRedis, RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { Request, Response, NextFunction } from 'express';
import redis from '../utils/redis.js';
import logger, { logEvent } from './logger.js';
import { rateLimitHitsTotal } from './metrics.js';

/**
 * Rate Limiting Module
 *
 * Rate limiting prevents abuse and protects transcoding resources by:
 * 1. Limiting API calls per user/IP to prevent DoS attacks
 * 2. Protecting expensive operations (uploads, transcoding) from abuse
 * 3. Ensuring fair resource distribution among users
 * 4. Preventing runaway scripts from overwhelming the system
 */

interface RateLimitConfig {
  points: number;
  duration: number;
  blockDuration: number;
}

// Rate limit configurations per endpoint category
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // Authentication - strict to prevent brute force
  auth: {
    points: 10, // 10 requests
    duration: 60, // per 60 seconds
    blockDuration: 300, // Block for 5 minutes after exceeding
  },

  // Upload endpoints - protect transcoding resources
  upload: {
    points: 5, // 5 uploads
    duration: 60, // per minute
    blockDuration: 120,
  },

  // Write operations (comments, reactions)
  write: {
    points: 20, // 20 writes
    duration: 60, // per minute
    blockDuration: 60,
  },

  // Read operations - more permissive
  read: {
    points: 100, // 100 reads
    duration: 60, // per minute
    blockDuration: 30,
  },

  // Default for unclassified endpoints
  default: {
    points: 60,
    duration: 60,
    blockDuration: 30,
  },
};

// Create rate limiters (using memory as fallback if Redis unavailable)
const rateLimiters = new Map<string, RateLimiterRedis | RateLimiterMemory>();

/**
 * Initialize a rate limiter for a category
 * Uses Redis if available, falls back to memory
 */
function createRateLimiter(category: string): RateLimiterRedis | RateLimiterMemory {
  const config = RATE_LIMITS[category] || RATE_LIMITS.default!;

  try {
    // Try Redis-based rate limiter
    return new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `ratelimit:${category}`,
      points: config.points,
      duration: config.duration,
      blockDuration: config.blockDuration,
    });
  } catch (error) {
    logger.warn(
      {
        event: 'rate_limiter_fallback',
        category,
        error: (error as Error).message,
      },
      'Falling back to memory-based rate limiter'
    );

    // Fallback to memory-based limiter
    return new RateLimiterMemory({
      keyPrefix: `ratelimit:${category}`,
      points: config.points,
      duration: config.duration,
      blockDuration: config.blockDuration,
    });
  }
}

/**
 * Get or create a rate limiter for a category
 */
function getRateLimiter(category: string): RateLimiterRedis | RateLimiterMemory {
  if (!rateLimiters.has(category)) {
    rateLimiters.set(category, createRateLimiter(category));
  }
  return rateLimiters.get(category)!;
}

/**
 * Get rate limit key from request
 * Uses user ID if authenticated, otherwise IP
 */
function getRateLimitKey(req: Request): string {
  if ((req as Request & { user?: { id: string } }).user?.id) {
    return `user:${(req as Request & { user: { id: string } }).user.id}`;
  }
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

/**
 * Classify endpoint into rate limit category
 */
function classifyEndpoint(method: string, path: string): string {
  // Auth endpoints
  if (path.startsWith('/api/v1/auth')) {
    return 'auth';
  }

  // Upload endpoints
  if (path.startsWith('/api/v1/uploads')) {
    return 'upload';
  }

  // Write operations
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    // Comments and reactions
    if (path.includes('/comments') || path.includes('/react') || path.includes('/subscribe')) {
      return 'write';
    }
  }

  // Read operations
  if (method === 'GET') {
    return 'read';
  }

  return 'default';
}

/**
 * Rate limiting middleware factory
 *
 * @param category - Optional category override
 * @returns Express middleware
 */
export function rateLimit(category: string | null = null): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const limitCategory = category || classifyEndpoint(req.method, req.path);
    const limiter = getRateLimiter(limitCategory);
    const key = getRateLimitKey(req);

    try {
      const result = await limiter.consume(key);

      // Add rate limit headers
      res.set({
        'X-RateLimit-Limit': (RATE_LIMITS[limitCategory]?.points || RATE_LIMITS.default!.points).toString(),
        'X-RateLimit-Remaining': result.remainingPoints.toString(),
        'X-RateLimit-Reset': new Date(Date.now() + result.msBeforeNext).toISOString(),
      });

      next();
    } catch (rejRes) {
      // Rate limit exceeded
      const rateLimiterRes = rejRes as RateLimiterRes;
      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);

      logEvent.rateLimitExceeded(req.log || logger, {
        endpoint: req.path,
        ip: req.ip,
        userId: (req as Request & { user?: { id: string } }).user?.id,
      });

      rateLimitHitsTotal.inc({
        endpoint: normalizeEndpoint(req.path),
        type: (req as Request & { user?: { id: string } }).user?.id ? 'user' : 'ip',
      });

      res.set({
        'Retry-After': retryAfter.toString(),
        'X-RateLimit-Limit': (RATE_LIMITS[limitCategory]?.points || RATE_LIMITS.default!.points).toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(Date.now() + rateLimiterRes.msBeforeNext).toISOString(),
      });

      res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit exceeded. Please retry after ${retryAfter} seconds.`,
        retryAfter,
      });
    }
  };
}

/**
 * Normalize endpoint path for metrics
 */
function normalizeEndpoint(path: string): string {
  return path
    .replace(/\/[a-f0-9-]{36}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{11}/g, '/:id');
}

interface StrictRateLimitConfig {
  points?: number;
  duration?: number;
  blockDuration?: number;
}

/**
 * Create a stricter rate limiter for specific operations
 *
 * @param config - Rate limit configuration
 * @returns Express middleware
 */
export function strictRateLimit(config: StrictRateLimitConfig): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'ratelimit:strict',
    points: config.points || 3,
    duration: config.duration || 60,
    blockDuration: config.blockDuration || 600,
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = getRateLimitKey(req);

    try {
      await limiter.consume(key);
      next();
    } catch (rejRes) {
      const rateLimiterRes = rejRes as RateLimiterRes;
      const retryAfter = Math.ceil(rateLimiterRes.msBeforeNext / 1000);

      res.status(429).json({
        error: 'Too many requests',
        message: `Operation limit exceeded. Please retry after ${retryAfter} seconds.`,
        retryAfter,
      });
    }
  };
}

export interface RateLimitStatus {
  remainingPoints: number;
  consumedPoints: number;
  isBlocked: boolean;
  msBeforeNext?: number;
}

/**
 * Get rate limit status for a key
 */
export async function getRateLimitStatus(category: string, key: string): Promise<RateLimitStatus | null> {
  const limiter = getRateLimiter(category);
  try {
    const result = await limiter.get(key);
    if (!result) {
      return {
        remainingPoints: RATE_LIMITS[category]?.points || RATE_LIMITS.default!.points,
        consumedPoints: 0,
        isBlocked: false,
      };
    }
    return {
      remainingPoints: result.remainingPoints,
      consumedPoints: result.consumedPoints,
      isBlocked: result.remainingPoints <= 0,
      msBeforeNext: result.msBeforeNext,
    };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to get rate limit status');
    return null;
  }
}

export default { rateLimit, strictRateLimit, getRateLimitStatus };
