/**
 * @fileoverview Main application entry point for the rate limiter service.
 *
 * This file bootstraps the Express server, initializes Redis connection,
 * sets up rate limiting middleware, and configures all API routes.
 * Includes graceful shutdown handling and comprehensive observability.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { getRedisClient, closeRedisClient, getRedisStatus } from './utils/redis.js';
import { RateLimiterFactory } from './algorithms/index.js';
import {
  createRateLimitRoutes,
  createMetricsRoutes,
  createAlgorithmInfoRoutes,
} from './routes/index.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';
import { logger, prometheusMetrics, getMetricsText, getMetricsContentType } from './shared/index.js';

/**
 * HTTP request logging and metrics middleware.
 * Records request duration and response status for Prometheus.
 */
function createHttpMetricsMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Listen for response finish
    res.on('finish', () => {
      const durationSeconds = (Date.now() - startTime) / 1000;

      // Normalize path to prevent high cardinality
      let normalizedPath = req.path;
      if (normalizedPath.includes('/state/')) {
        normalizedPath = '/api/ratelimit/state/:identifier';
      } else if (normalizedPath.includes('/reset/')) {
        normalizedPath = '/api/ratelimit/reset/:identifier';
      }

      prometheusMetrics.recordHttp(
        req.method,
        normalizedPath,
        res.statusCode,
        durationSeconds
      );
    });

    next();
  };
}

/**
 * Main application bootstrap function.
 * Sets up the Express server with all middleware and routes,
 * waits for Redis connection, and starts listening for requests.
 */
async function main() {
  const app = express();

  // Core middleware
  app.use(cors({ origin: config.cors.origin }));
  app.use(express.json());

  // Trust proxy for accurate client IP addresses behind load balancers
  app.set('trust proxy', true);

  // HTTP metrics middleware (before routes)
  app.use(createHttpMetricsMiddleware());

  // Initialize Redis connection
  const redis = getRedisClient();

  // Wait for Redis to be ready before starting the server
  // But don't block forever - allow startup with degraded mode
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (config.degradation.mode === 'allow') {
          logger.warn('Redis connection timeout, starting in degraded mode');
          resolve();
        } else {
          reject(new Error('Redis connection timeout'));
        }
      }, config.redis.connectTimeout);

      redis.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      redis.once('error', (err) => {
        if (config.degradation.mode === 'allow') {
          logger.warn({ error: err.message }, 'Redis error during startup, starting in degraded mode');
          clearTimeout(timeout);
          resolve();
        } else {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to connect to Redis');
    throw error;
  }

  const redisStatus = await getRedisStatus();
  logger.info(
    { connected: redisStatus.connected, circuitBreaker: redisStatus.circuitBreakerState },
    'Redis status at startup'
  );

  // Initialize rate limiter factory with all algorithm implementations
  const factory = new RateLimiterFactory(redis, config.redis.keyPrefix);

  // Apply rate limiting middleware to demo endpoints
  // This demonstrates the middleware usage for real API protection
  app.use(
    '/api/demo',
    createRateLimitMiddleware(factory, redis, {
      identifier: (req) => req.headers['x-api-key'] as string || req.ip || 'unknown',
      algorithm: 'sliding_window',
      limit: 10,
      windowSeconds: 60,
    })
  );

  /**
   * Demo endpoint to test rate limiting in action.
   * Protected by the rate limit middleware applied above.
   */
  app.get('/api/demo', (_req, res) => {
    res.json({
      message: 'Request successful',
      timestamp: Date.now(),
      serverPort: config.port,
    });
  });

  // Mount API routes
  app.use('/api/ratelimit', createRateLimitRoutes(factory, redis));
  app.use('/api/metrics', createMetricsRoutes(redis));
  app.use('/api/algorithms', createAlgorithmInfoRoutes());

  /**
   * Prometheus metrics endpoint at root /metrics path.
   * Standard location for Prometheus scraping.
   */
  app.get('/metrics', async (_req, res) => {
    try {
      const metricsText = await getMetricsText();
      res.set('Content-Type', getMetricsContentType());
      res.send(metricsText);
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Prometheus metrics error');
      res.status(500).send('# Error collecting metrics');
    }
  });

  /**
   * Root endpoint providing API documentation.
   * Lists all available endpoints for easy discovery.
   */
  app.get('/', (_req, res) => {
    res.json({
      name: 'Rate Limiter Service',
      version: '1.0.0',
      endpoints: {
        check: 'POST /api/ratelimit/check',
        state: 'GET /api/ratelimit/state/:identifier',
        reset: 'DELETE /api/ratelimit/reset/:identifier',
        batchCheck: 'POST /api/ratelimit/batch-check',
        metrics: 'GET /api/metrics',
        prometheus: 'GET /metrics',
        health: 'GET /api/metrics/health',
        ready: 'GET /api/metrics/ready',
        live: 'GET /api/metrics/live',
        algorithms: 'GET /api/algorithms',
        demo: 'GET /api/demo',
      },
      config: {
        degradationMode: config.degradation.mode,
        defaultAlgorithm: config.defaults.algorithm,
        defaultLimit: config.defaults.limit,
        defaultWindowSeconds: config.defaults.windowSeconds,
      },
    });
  });

  // Start HTTP server
  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        degradationMode: config.degradation.mode,
      },
      'Rate Limiter Service started'
    );
    logger.info(`  - Check endpoint: http://localhost:${config.port}/api/ratelimit/check`);
    logger.info(`  - Prometheus: http://localhost:${config.port}/metrics`);
    logger.info(`  - Health: http://localhost:${config.port}/api/metrics/health`);
    logger.info(`  - Demo (rate limited): http://localhost:${config.port}/api/demo`);
  });

  /**
   * Graceful shutdown handler.
   * Closes HTTP server and Redis connection cleanly.
   */
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully');

    // Stop accepting new connections
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Close Redis connection
    await closeRedisClient();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  // Handle termination signals for graceful shutdown
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
  });
}

// Start the application
main().catch((error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Failed to start server');
  process.exit(1);
});
