// API routes for rate limiting service

import { Router, Request, Response } from 'express';
import { RateLimiterFactory } from '../algorithms/index.js';
import { Algorithm, RateLimitCheckRequest } from '../types/index.js';
import { getMetrics, recordMetric } from '../utils/redis.js';
import { config } from '../config/index.js';
import Redis from 'ioredis';

export function createRateLimitRoutes(factory: RateLimiterFactory, redis: Redis): Router {
  const router = Router();

  // Check rate limit (consumes a token)
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

  // Get current state (does not consume a token)
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

  // Reset rate limit for an identifier
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

  // Batch check for multiple identifiers
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

export function createMetricsRoutes(redis: Redis): Router {
  const router = Router();

  // Get aggregated metrics
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const metrics = await getMetrics(redis);
      res.json(metrics);
    } catch (error) {
      console.error('Metrics error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get health status
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

export function createAlgorithmInfoRoutes(): Router {
  const router = Router();

  // List available algorithms
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
