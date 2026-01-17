/**
 * @fileoverview Express middleware for rate limiting API endpoints.
 *
 * Provides a configurable middleware factory that can be applied to any Express route.
 * The middleware integrates with the rate limiter algorithms and automatically sets
 * standard rate limit headers on responses. Includes circuit breaker protection
 * and graceful degradation.
 */

import { Request, Response, NextFunction } from 'express';
import { RateLimiterFactory } from '../algorithms/index.js';
import { Algorithm, RateLimitResult } from '../types/index.js';
import { recordMetric } from '../utils/redis.js';
import { logger, prometheusMetrics } from '../shared/index.js';
import { config } from '../config/index.js';
import Redis from 'ioredis';

/**
 * Configuration options for the rate limiting middleware.
 */
export interface RateLimitMiddlewareOptions {
  /**
   * Function to extract the rate limit identifier from a request.
   * Default: uses request IP address.
   */
  identifier?: (req: Request) => string;
  /** Rate limiting algorithm to use */
  algorithm?: Algorithm;
  /** Maximum requests per window */
  limit?: number;
  /** Window duration in seconds */
  windowSeconds?: number;
  /** Burst capacity for bucket algorithms */
  burstCapacity?: number;
  /** Token refill rate for token bucket */
  refillRate?: number;
  /** Leak rate for leaky bucket */
  leakRate?: number;
  /** Request paths to skip rate limiting (prefix matching) */
  skipPaths?: string[];
  /** Custom handler when rate limit is exceeded */
  onRateLimited?: (req: Request, res: Response, result: RateLimitResult) => void;
}

/**
 * Create an Express middleware for rate limiting.
 * The middleware checks each request against the configured rate limit and
 * sets appropriate headers. If the limit is exceeded, returns 429 Too Many Requests.
 *
 * Design decision: Fail-open on Redis errors to avoid blocking legitimate users
 * during temporary infrastructure issues.
 *
 * @param factory - RateLimiterFactory instance with configured algorithms
 * @param redis - Redis client for recording metrics
 * @param options - Middleware configuration options
 * @returns Express middleware function
 *
 * @example
 * ```ts
 * app.use('/api', createRateLimitMiddleware(factory, redis, {
 *   identifier: (req) => req.headers['x-api-key'] || req.ip,
 *   algorithm: 'sliding_window',
 *   limit: 100,
 *   windowSeconds: 60,
 * }));
 * ```
 */
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
    // Skip rate limiting for certain paths (e.g., health checks)
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
      await recordMetric(redis, result.allowed ? 'allowed' : 'denied', latencyMs, algorithm);

      // Set standard rate limit headers (compatible with RFC 6585)
      res.set({
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
        'X-RateLimit-Algorithm': algorithm,
      });

      if (!result.allowed) {
        res.set('Retry-After', (result.retryAfter || 1).toString());

        logger.debug(
          {
            identifier: id,
            algorithm,
            remaining: result.remaining,
            latencyMs,
          },
          'Rate limit exceeded'
        );

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
      logger.error(
        { error: (error as Error).message, identifier: id },
        'Rate limit check failed'
      );

      // Graceful degradation based on configuration
      if (config.degradation.mode === 'allow') {
        prometheusMetrics.recordFallback('middleware_error');
        next();
      } else {
        return res.status(503).json({
          error: 'Service Unavailable',
          message: 'Rate limiting temporarily unavailable',
        });
      }
    }
  };
}
