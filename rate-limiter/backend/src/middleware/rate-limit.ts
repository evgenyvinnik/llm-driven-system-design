// Rate limit middleware for Express

import { Request, Response, NextFunction } from 'express';
import { RateLimiterFactory } from '../algorithms/index.js';
import { Algorithm, RateLimitResult } from '../types/index.js';
import { recordMetric } from '../utils/redis.js';
import Redis from 'ioredis';

export interface RateLimitMiddlewareOptions {
  identifier?: (req: Request) => string;
  algorithm?: Algorithm;
  limit?: number;
  windowSeconds?: number;
  burstCapacity?: number;
  refillRate?: number;
  leakRate?: number;
  skipPaths?: string[];
  onRateLimited?: (req: Request, res: Response, result: RateLimitResult) => void;
}

export function createRateLimitMiddleware(
  factory: RateLimiterFactory,
  redis: Redis,
  options: RateLimitMiddlewareOptions = {}
) {
  const {
    identifier = (req) => req.ip || 'unknown',
    algorithm = 'sliding_window',
    limit = 100,
    windowSeconds = 60,
    burstCapacity,
    refillRate,
    leakRate,
    skipPaths = [],
    onRateLimited,
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip certain paths
    if (skipPaths.some(path => req.path.startsWith(path))) {
      return next();
    }

    const startTime = Date.now();
    const id = identifier(req);

    try {
      const result = await factory.check(
        algorithm,
        id,
        limit,
        windowSeconds,
        { burstCapacity, refillRate, leakRate }
      );

      const latencyMs = Date.now() - startTime;
      await recordMetric(redis, result.allowed ? 'allowed' : 'denied', latencyMs);

      // Set rate limit headers
      res.set({
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
        'X-RateLimit-Algorithm': algorithm,
      });

      if (!result.allowed) {
        res.set('Retry-After', (result.retryAfter || 1).toString());

        if (onRateLimited) {
          onRateLimited(req, res, result);
        } else {
          return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded',
            retryAfter: result.retryAfter,
            limit: result.limit,
            resetTime: result.resetTime,
          });
        }
        return;
      }

      next();
    } catch (error) {
      console.error('Rate limit check failed:', error);
      // Fail open - allow request on error
      next();
    }
  };
}
