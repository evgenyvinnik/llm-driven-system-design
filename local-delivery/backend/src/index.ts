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
import { redis, publisher, initRedis, pruneStaleDrivers } from './utils/redis.js';
import { setupWebSocket, closeWebSocket, getConnectedClientCount } from './websocket/handler.js';

import authRoutes from './routes/auth.js';
import merchantRoutes from './routes/merchants.js';
import orderRoutes from './routes/orders.js';
import driverRoutes from './routes/driver.js';
import adminRoutes from './routes/admin.js';

// Shared modules
import logger from './shared/logger.js';
import { registry, httpRequestDurationHistogram, httpRequestsTotal } from './shared/metrics.js';
import {
  getDriverMatchingCircuitBreakerStatus,
  startDriverMatchingWithCircuitBreaker,
  startDispatchSweeper,
  releaseAllDispatchLeases,
  expireOldOffers,
  DISPATCH_OWNER,
} from './services/order/index.js';
import type { DispatchSweeper } from './services/order/dispatch.js';
import { cleanupExpiredIdempotencyKeys } from './shared/idempotency.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const startTime = Date.now();

/** Set when shutdown begins: readiness fails so the load balancer stops routing here. */
let shuttingDown = false;

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
 * Verifies database and Redis connectivity; returns 503 while shutting down
 * so traffic drains to other instances.
 * Returns detailed status of all dependencies.
 */
app.get('/health', async (_req, res) => {
  if (shuttingDown) {
    res.status(503).json({ status: 'shutting_down' });
    return;
  }

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
    instance: DISPATCH_OWNER,
    websocketClients: getConnectedClientCount(),
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
 * Background jobs:
 * - hourly cleanup of expired idempotency keys;
 * - every 30 s, couriers who stopped pinging are pruned from the geo index;
 * - the dispatch sweeper resumes matching for unassigned orders whose lease
 *   lapsed (owner crashed or backed off), on whichever instance claims them.
 */
let cleanupInterval: NodeJS.Timeout | undefined;
let pruneInterval: NodeJS.Timeout | undefined;
let dispatchSweeper: DispatchSweeper | undefined;

function startBackgroundJobs() {
  cleanupInterval = setInterval(async () => {
    try {
      await cleanupExpiredIdempotencyKeys();
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Idempotency key cleanup failed');
    }
  }, 60 * 60 * 1000); // 1 hour

  pruneInterval = setInterval(async () => {
    try {
      const pruned = await pruneStaleDrivers();
      if (pruned.length > 0) {
        logger.info({ count: pruned.length }, 'Pruned couriers with stale locations');
      }
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Geo index prune failed');
    }
  }, 30 * 1000);

  dispatchSweeper = startDispatchSweeper({
    dispatch: (orderId) => startDriverMatchingWithCircuitBreaker(orderId),
    beforeSweep: () => expireOldOffers(),
  });
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

    startBackgroundJobs();
    logger.info({ instance: DISPATCH_OWNER }, 'Started background jobs (cleanup, geo prune, dispatch sweeper)');

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
 * Graceful shutdown:
 * 1. Fail readiness and stop accepting new HTTP connections.
 * 2. Close WebSockets with "going away" so clients reconnect elsewhere.
 * 3. Release this instance's dispatch leases so another instance resumes
 *    matching on its next sweep instead of waiting for the leases to expire.
 * 4. Wait (bounded) for in-flight HTTP requests, then close PostgreSQL and Redis.
 */
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received');

  clearInterval(cleanupInterval);
  clearInterval(pruneInterval);
  dispatchSweeper?.stop();

  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));

  try {
    await closeWebSocket();
    const released = await releaseAllDispatchLeases();
    logger.info({ released }, 'Released dispatch leases');
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Shutdown step failed');
  }

  await Promise.race([httpClosed, new Promise((resolve) => setTimeout(resolve, 10_000))]);

  await pool.end().catch(() => undefined);
  await redis.quit().catch(() => undefined);
  await publisher.quit().catch(() => undefined);

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
