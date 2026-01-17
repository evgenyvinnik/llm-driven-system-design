/**
 * Main entry point for the local delivery backend server.
 * Initializes Express, connects to PostgreSQL and Redis,
 * sets up WebSocket server, and configures API routes.
 *
 * Features:
 * - Structured JSON logging with pino
 * - Prometheus metrics endpoint (/metrics)
 * - Enhanced health checks with dependency status
 * - Request duration tracking
 *
 * @module index
 */
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';

import { pool } from './utils/db.js';
import { redis, publisher, initRedis } from './utils/redis.js';
import { setupWebSocket } from './websocket/handler.js';

import authRoutes from './routes/auth.js';
import merchantRoutes from './routes/merchants.js';
import orderRoutes from './routes/orders.js';
import driverRoutes from './routes/driver.js';
import adminRoutes from './routes/admin.js';

// Shared modules
import logger from './shared/logger.js';
import { registry, httpRequestDurationHistogram, httpRequestsTotal } from './shared/metrics.js';
import { getDriverMatchingCircuitBreakerStatus } from './services/orderService.js';
import { cleanupExpiredIdempotencyKeys } from './shared/idempotency.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const startTime = Date.now();

/**
 * CORS and JSON body parsing middleware.
 * Allows cross-origin requests for frontend development.
 */
app.use(cors());
app.use(express.json());

/**
 * Request logging and metrics middleware.
 * Logs HTTP method, path, status code, and response time.
 * Tracks request duration histogram for Prometheus.
 */
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000; // Convert to seconds
    const route = req.route?.path || req.path;

    // Log request
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration_ms: duration * 1000,
      userAgent: req.headers['user-agent'],
    }, 'HTTP request');

    // Track metrics
    httpRequestDurationHistogram.observe(
      { method: req.method, route, status_code: res.statusCode.toString() },
      duration
    );
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    });
  });

  next();
});

/**
 * Prometheus metrics endpoint.
 * Exposes all registered metrics in Prometheus text format.
 * Used by Prometheus scraper for monitoring and alerting.
 */
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to generate metrics');
    res.status(500).end('Error generating metrics');
  }
});

/**
 * Basic liveness check endpoint.
 * Returns 200 if the server process is running.
 * Used by load balancers for basic health checks.
 */
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Readiness check endpoint for load balancer and monitoring.
 * Verifies database and Redis connectivity.
 * Returns detailed status of all dependencies.
 */
app.get('/health', async (_req, res) => {
  const healthCheck = {
    status: 'healthy' as 'healthy' | 'unhealthy' | 'degraded',
    timestamp: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || '1.0.0',
    services: {
      database: 'unknown' as 'connected' | 'disconnected' | 'unknown',
      redis: 'unknown' as 'connected' | 'disconnected' | 'unknown',
    },
    circuitBreakers: {
      driverMatching: getDriverMatchingCircuitBreakerStatus(),
    },
  };

  try {
    // Check database
    await pool.query('SELECT 1');
    healthCheck.services.database = 'connected';
  } catch (error) {
    healthCheck.services.database = 'disconnected';
    healthCheck.status = 'degraded';
    logger.error({ error: (error as Error).message }, 'Database health check failed');
  }

  try {
    // Check Redis
    await redis.ping();
    healthCheck.services.redis = 'connected';
  } catch (error) {
    healthCheck.services.redis = 'disconnected';
    healthCheck.status = 'degraded';
    logger.error({ error: (error as Error).message }, 'Redis health check failed');
  }

  // Determine final status
  if (
    healthCheck.services.database === 'disconnected' &&
    healthCheck.services.redis === 'disconnected'
  ) {
    healthCheck.status = 'unhealthy';
    res.status(503);
  } else if (
    healthCheck.services.database === 'disconnected' ||
    healthCheck.services.redis === 'disconnected'
  ) {
    healthCheck.status = 'degraded';
    res.status(200); // Still serving, but degraded
  }

  res.json(healthCheck);
});

/**
 * API Routes registration.
 * All routes are prefixed with /api/v1 for versioning.
 */
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/merchants', merchantRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/driver', driverRoutes);
app.use('/api/v1/admin', adminRoutes);

/**
 * 404 handler for unknown routes.
 */
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

/**
 * Global error handler for unhandled exceptions.
 */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

/**
 * HTTP server instance.
 * WebSocket server is attached to this for connection upgrades.
 */
const server = createServer(app);

/**
 * Attach WebSocket server for real-time communication.
 */
setupWebSocket(server);

/**
 * Periodic cleanup of expired idempotency keys.
 * Runs every hour to prevent database bloat.
 */
let cleanupInterval: NodeJS.Timeout;

function startPeriodicCleanup() {
  // Run cleanup every hour
  cleanupInterval = setInterval(async () => {
    try {
      await cleanupExpiredIdempotencyKeys();
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Idempotency key cleanup failed');
    }
  }, 60 * 60 * 1000); // 1 hour
}

/**
 * Initializes database and Redis connections, then starts the HTTP server.
 * Logs connection status and available endpoints.
 */
async function start() {
  try {
    // Connect to Redis
    await initRedis();
    logger.info('Connected to Redis');

    // Test database connection
    await pool.query('SELECT 1');
    logger.info('Connected to PostgreSQL');

    // Start periodic cleanup
    startPeriodicCleanup();
    logger.info('Started periodic cleanup jobs');

    server.listen(PORT, () => {
      logger.info({
        port: PORT,
        healthCheck: `http://localhost:${PORT}/health`,
        metrics: `http://localhost:${PORT}/metrics`,
        api: `http://localhost:${PORT}/api/v1`,
        websocket: `ws://localhost:${PORT}/ws`,
      }, 'Server started');
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Graceful shutdown handlers.
 * Closes all connections cleanly when receiving termination signals.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');

  // Stop cleanup interval
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  // Close server
  server.close();

  // Close connections
  await pool.end();
  await redis.quit();
  await publisher.quit();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
