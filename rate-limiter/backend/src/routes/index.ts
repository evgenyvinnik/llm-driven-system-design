/**
 * @fileoverview API routes for the rate limiting service.
 *
 * Defines three route groups:
 * - Rate limit routes: Check, query, and reset rate limits
 * - Metrics routes: Get aggregated metrics and health status
 * - Algorithm info routes: List available algorithms with documentation
 */

import { Router, Request, Response } from 'express';
import { RateLimiterFactory } from '../algorithms/index.js';
import { Algorithm, RateLimitCheckRequest } from '../types/index.js';
import { getMetrics, recordMetric } from '../utils/redis.js';
import { config } from '../config/index.js';
import Redis from 'ioredis';

/**
 * Create routes for rate limit operations.
 * These endpoints allow clients to check rate limits, query current state,
 * reset limits, and perform batch operations.
 *
 * @param factory - RateLimiterFactory instance for rate limit operations
 * @param redis - Redis client for metrics recording
 * @returns Express router with rate limit endpoints
 */
export function createRateLimitRoutes(factory: RateLimiterFactory, redis: Redis): Router {
  const router = Router();

  /**
   * POST /check - Check rate limit and consume a token.
   * This is the primary endpoint for rate limiting checks.
   * Returns 200 if allowed, 429 if rate limited.
   */
  router.post('/check', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const body = req.body as RateLimitCheckRequest;

      if (!body.identifier) {
        return res.status(400).json({ error: 'identifier is required' });
      }

      const algorithm: Algorithm = body.algorithm || config.defaults.algorithm;
      const limit = body.limit || config.defaults.limit;
      const windowSeconds = body.windowSeconds || config.defaults.windowSeconds;

      const result = await factory.check(
        algorithm,
        body.identifier,
        limit,
        windowSeconds,
        {
          burstCapacity: body.burstCapacity || config.defaults.burstCapacity,
          refillRate: body.refillRate || config.defaults.refillRate,
          leakRate: body.leakRate || config.defaults.leakRate,
        }
      );

      const latencyMs = Date.now() - startTime;
      await recordMetric(redis, result.allowed ? 'allowed' : 'denied', latencyMs);

      // Set standard rate limit headers
      res.set({
        'X-RateLimit-Limit': result.limit.toString(),
        'X-RateLimit-Remaining': result.remaining.toString(),
        'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
        'X-RateLimit-Algorithm': algorithm,
      });

      if (!result.allowed) {
        res.set('Retry-After', (result.retryAfter || 1).toString());
        return res.status(429).json({
          ...result,
          algorithm,
          latencyMs,
        });
      }

      res.json({
        ...result,
        algorithm,
        latencyMs,
      });
    } catch (error) {
      console.error('Rate limit check error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /state/:identifier - Get current rate limit state without consuming.
   * Useful for displaying remaining quota to users or admin monitoring.
   */
  router.get('/state/:identifier', async (req: Request, res: Response) => {
    try {
      const { identifier } = req.params;
      const algorithm = (req.query.algorithm as Algorithm) || config.defaults.algorithm;
      const limit = parseInt(req.query.limit as string) || config.defaults.limit;
      const windowSeconds = parseInt(req.query.windowSeconds as string) || config.defaults.windowSeconds;

      const result = await factory.getState(
        algorithm,
        identifier,
        limit,
        windowSeconds,
        {
          burstCapacity: parseInt(req.query.burstCapacity as string) || config.defaults.burstCapacity,
          refillRate: parseFloat(req.query.refillRate as string) || config.defaults.refillRate,
          leakRate: parseFloat(req.query.leakRate as string) || config.defaults.leakRate,
        }
      );

      res.json({
        identifier,
        algorithm,
        ...result,
      });
    } catch (error) {
      console.error('Get state error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /reset/:identifier - Reset rate limit state for an identifier.
   * Can optionally specify an algorithm to reset only that algorithm's state.
   */
  router.delete('/reset/:identifier', async (req: Request, res: Response) => {
    try {
      const { identifier } = req.params;
      const algorithm = req.query.algorithm as Algorithm | undefined;

      if (algorithm) {
        await factory.reset(algorithm, identifier);
      } else {
        await factory.resetAll(identifier);
      }

      res.json({
        message: 'Rate limit reset successfully',
        identifier,
        algorithm: algorithm || 'all',
      });
    } catch (error) {
      console.error('Reset error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /batch-check - Check rate limits for multiple identifiers at once.
   * Useful for services that need to validate multiple rate limits in one call.
   * Maximum 100 checks per batch to prevent abuse.
   */
  router.post('/batch-check', async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const { checks } = req.body as { checks: RateLimitCheckRequest[] };

      if (!Array.isArray(checks) || checks.length === 0) {
        return res.status(400).json({ error: 'checks array is required' });
      }

      if (checks.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 checks per batch' });
      }

      const results = await Promise.all(
        checks.map(async (check) => {
          const algorithm: Algorithm = check.algorithm || config.defaults.algorithm;
          const limit = check.limit || config.defaults.limit;
          const windowSeconds = check.windowSeconds || config.defaults.windowSeconds;

          const result = await factory.check(
            algorithm,
            check.identifier,
            limit,
            windowSeconds,
            {
              burstCapacity: check.burstCapacity || config.defaults.burstCapacity,
              refillRate: check.refillRate || config.defaults.refillRate,
              leakRate: check.leakRate || config.defaults.leakRate,
            }
          );

          await recordMetric(redis, result.allowed ? 'allowed' : 'denied', 0);

          return {
            identifier: check.identifier,
            algorithm,
            ...result,
          };
        })
      );

      const latencyMs = Date.now() - startTime;

      res.json({
        results,
        count: results.length,
        latencyMs,
      });
    } catch (error) {
      console.error('Batch check error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

/**
 * Create routes for metrics and health monitoring.
 * These endpoints support dashboards and monitoring systems.
 *
 * @param redis - Redis client for fetching metrics and health checks
 * @returns Express router with metrics endpoints
 */
export function createMetricsRoutes(redis: Redis): Router {
  const router = Router();

  /**
   * GET / - Get aggregated metrics for the last 5 minutes.
   * Returns request counts, latency statistics, and active identifier count.
   */
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const metrics = await getMetrics(redis);
      res.json(metrics);
    } catch (error) {
      console.error('Metrics error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /health - Health check endpoint for load balancers and monitoring.
   * Returns Redis connection status and server uptime.
   */
  router.get('/health', async (_req: Request, res: Response) => {
    try {
      const pingStart = Date.now();
      await redis.ping();
      const redisPingMs = Date.now() - pingStart;

      res.json({
        status: 'healthy',
        redis: {
          connected: true,
          pingMs: redisPingMs,
        },
        uptime: process.uptime(),
        timestamp: Date.now(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'unhealthy',
        redis: {
          connected: false,
          error: (error as Error).message,
        },
        uptime: process.uptime(),
        timestamp: Date.now(),
      });
    }
  });

  return router;
}

/**
 * Create routes for algorithm documentation.
 * Provides information about available algorithms to help clients choose.
 *
 * @returns Express router with algorithm info endpoints
 */
export function createAlgorithmInfoRoutes(): Router {
  const router = Router();

  /**
   * GET / - List all available rate limiting algorithms.
   * Returns descriptions, pros/cons, and parameters for each algorithm.
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      algorithms: [
        {
          name: 'fixed_window',
          description: 'Simple counter that resets at fixed time boundaries',
          pros: ['Simple', 'Memory efficient (one counter per window)'],
          cons: ['Burst at window boundaries (can allow 2x limit briefly)'],
          parameters: ['limit', 'windowSeconds'],
        },
        {
          name: 'sliding_window',
          description: 'Combines current and previous window counts weighted by time position',
          pros: ['Smooth limiting', 'Memory efficient'],
          cons: ['Approximate (but within 1-2% accuracy)'],
          parameters: ['limit', 'windowSeconds'],
        },
        {
          name: 'sliding_log',
          description: 'Stores timestamp of each request, counts requests in sliding window',
          pros: ['Perfectly accurate sliding window'],
          cons: ['Memory-intensive (stores every request timestamp)'],
          parameters: ['limit', 'windowSeconds'],
        },
        {
          name: 'token_bucket',
          description: 'Bucket refills at constant rate, requests consume tokens',
          pros: ['Allows controlled bursts', 'Smooth rate limiting'],
          cons: ['More complex state', 'Harder to explain limits to users'],
          parameters: ['burstCapacity', 'refillRate'],
        },
        {
          name: 'leaky_bucket',
          description: 'Requests enter queue, processed at fixed rate',
          pros: ['Smoothest output rate', 'Prevents bursts entirely'],
          cons: ['Requests may queue, adding latency'],
          parameters: ['burstCapacity', 'leakRate'],
        },
      ],
      defaults: config.defaults,
    });
  });

  return router;
}
