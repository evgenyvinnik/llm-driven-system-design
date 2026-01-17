/**
 * @fileoverview Main entry point for the Ad Click Aggregator backend service.
 * Sets up Express server with middleware, routes, health checks, and Prometheus metrics.
 * This service handles high-volume ad click ingestion, real-time aggregation,
 * fraud detection, and analytics queries.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import clicksRouter from './routes/clicks.js';
import analyticsRouter from './routes/analytics.js';
import adminRouter from './routes/admin.js';
import { testConnection as testDbConnection } from './services/database.js';
import { testConnection as testRedisConnection, getMemoryUsage } from './services/redis.js';
import { logger, createRequestLogger, logHelpers } from './shared/logger.js';
import {
  getMetrics,
  getMetricsContentType,
  httpMetrics,
  healthMetrics,
  clickMetrics,
} from './shared/metrics.js';
import { ENV_CONFIG, SLO_TARGETS } from './shared/config.js';

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000', 10);

// Trust proxy for correct client IP detection
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/**
 * Request logging and metrics middleware.
 * Adds request ID, tracks latency, and logs all requests.
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const start = Date.now();

  // Attach request ID for downstream logging
  req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);

  // Track active requests
  httpMetrics.activeRequests.inc();

  // Create request-scoped logger
  const requestLog = createRequestLogger(requestId, req.method, req.path);

  // Attach logger to request for use in handlers
  (req as Request & { log: typeof requestLog }).log = requestLog;

  res.on('finish', () => {
    const duration = Date.now() - start;
    const durationSeconds = duration / 1000;

    // Update metrics
    httpMetrics.activeRequests.dec();
    httpMetrics.requests.inc({
      method: req.method,
      path: normalizePath(req.path),
      status: res.statusCode.toString(),
    });
    httpMetrics.latency.observe(
      { method: req.method, path: normalizePath(req.path) },
      durationSeconds
    );

    // Log request completion
    logHelpers.httpRequest(requestLog, req.method, req.path, res.statusCode, duration);
  });

  next();
});

/**
 * Normalizes request path for metrics (removes variable path segments).
 * Prevents cardinality explosion in Prometheus.
 */
function normalizePath(path: string): string {
  // Replace UUIDs and numeric IDs with placeholders
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id')
    .replace(/\/ad_\w+/g, '/:adId')
    .replace(/\/camp_\w+/g, '/:campaignId')
    .replace(/\/adv_\w+/g, '/:advertiserId');
}

/**
 * GET /metrics
 * Prometheus metrics endpoint for scraping.
 * Exposes all application metrics in Prometheus text format.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    // Update Redis memory metric before scrape
    await getMemoryUsage();

    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.end(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to generate metrics');
    res.status(500).end('Failed to generate metrics');
  }
});

/**
 * GET /health
 * Basic health check for load balancer probes.
 * Returns 200 if service is running (does not check dependencies).
 */
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 * Readiness probe - checks all dependencies.
 * Returns 200 only if service is ready to accept traffic.
 */
app.get('/health/ready', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  const [dbHealthy, redisHealthy] = await Promise.all([
    testDbConnection(),
    testRedisConnection(),
  ]);

  const allHealthy = dbHealthy && redisHealthy;
  const status = allHealthy ? 'ready' : 'not_ready';
  const statusCode = allHealthy ? 200 : 503;

  // Update health metrics
  healthMetrics.status.set({ component: 'database' }, dbHealthy ? 1 : 0);
  healthMetrics.status.set({ component: 'redis' }, redisHealthy ? 1 : 0);
  healthMetrics.status.set({ component: 'overall' }, allHealthy ? 1 : 0);

  if (allHealthy) {
    healthMetrics.lastCheck.set(Date.now() / 1000);
  }

  const response = {
    status,
    timestamp: new Date().toISOString(),
    checkDurationMs: Date.now() - startTime,
    services: {
      database: dbHealthy ? 'connected' : 'disconnected',
      redis: redisHealthy ? 'connected' : 'disconnected',
    },
    slo: {
      availabilityTarget: SLO_TARGETS.AVAILABILITY_TARGET,
      ingestionLatencyP95Ms: SLO_TARGETS.INGESTION_LATENCY_P95_MS,
    },
  };

  logHelpers.healthCheck(logger, allHealthy, { database: dbHealthy, redis: redisHealthy });

  res.status(statusCode).json(response);
});

/**
 * GET /health/live
 * Liveness probe - indicates if the process is running.
 * Used by Kubernetes to determine if the container should be restarted.
 */
app.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
});

// API routes
app.use('/api/v1/clicks', clicksRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/admin', adminRouter);

/**
 * Error handling middleware.
 * Logs errors and returns appropriate error response.
 */
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const requestLog = (req as Request & { log?: typeof logger }).log || logger;

  requestLog.error(
    {
      error: err.message,
      stack: ENV_CONFIG.NODE_ENV === 'development' ? err.stack : undefined,
    },
    'Unhandled error'
  );

  res.status(500).json({
    error: 'Internal server error',
    message: ENV_CONFIG.NODE_ENV === 'development' ? err.message : undefined,
    requestId: req.headers['x-request-id'],
  });
});

/**
 * 404 handler for unknown routes.
 */
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      env: ENV_CONFIG.NODE_ENV,
      version: ENV_CONFIG.SERVICE_VERSION,
    },
    `Ad Click Aggregator backend started`
  );

  logger.info(`Health check: http://localhost:${PORT}/health/ready`);
  logger.info(`Metrics: http://localhost:${PORT}/metrics`);
  logger.info(`API Base URL: http://localhost:${PORT}/api/v1`);
});

export default app;
