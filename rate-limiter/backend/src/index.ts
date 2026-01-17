// Main application entry point

import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { getRedisClient, closeRedisClient } from './utils/redis.js';
import { RateLimiterFactory } from './algorithms/index.js';
import {
  createRateLimitRoutes,
  createMetricsRoutes,
  createAlgorithmInfoRoutes,
} from './routes/index.js';
import { createRateLimitMiddleware } from './middleware/rate-limit.js';

async function main() {
  const app = express();

  // Middleware
  app.use(cors({ origin: config.cors.origin }));
  app.use(express.json());

  // Trust proxy for accurate IP address
  app.set('trust proxy', true);

  // Initialize Redis
  const redis = getRedisClient();

  // Wait for Redis connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Redis connection timeout'));
    }, 10000);

    redis.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });

    redis.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  console.log('Redis connected successfully');

  // Initialize rate limiter factory
  const factory = new RateLimiterFactory(redis, config.redis.keyPrefix);

  // Apply rate limiting to /api/demo endpoints
  app.use(
    '/api/demo',
    createRateLimitMiddleware(factory, redis, {
      identifier: (req) => req.headers['x-api-key'] as string || req.ip || 'unknown',
      algorithm: 'sliding_window',
      limit: 10,
      windowSeconds: 60,
    })
  );

  // Demo endpoint to test rate limiting
  app.get('/api/demo', (_req, res) => {
    res.json({
      message: 'Request successful',
      timestamp: Date.now(),
      serverPort: config.port,
    });
  });

  // API Routes
  app.use('/api/ratelimit', createRateLimitRoutes(factory, redis));
  app.use('/api/metrics', createMetricsRoutes(redis));
  app.use('/api/algorithms', createAlgorithmInfoRoutes());

  // Root endpoint
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
        health: 'GET /api/metrics/health',
        algorithms: 'GET /api/algorithms',
        demo: 'GET /api/demo',
      },
    });
  });

  // Start server
  const server = app.listen(config.port, () => {
    console.log(`Rate Limiter Service running on port ${config.port}`);
    console.log(`  - Check endpoint: http://localhost:${config.port}/api/ratelimit/check`);
    console.log(`  - Metrics: http://localhost:${config.port}/api/metrics`);
    console.log(`  - Health: http://localhost:${config.port}/api/metrics/health`);
    console.log(`  - Demo (rate limited): http://localhost:${config.port}/api/demo`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down gracefully...');
    server.close(() => {
      console.log('HTTP server closed');
    });
    await closeRedisClient();
    console.log('Redis connection closed');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
