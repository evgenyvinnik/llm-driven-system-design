/**
 * Main entry point for the Price Tracker API server.
 * Configures Express with middleware, routes, and starts the HTTP server.
 * Handles graceful shutdown on SIGTERM/SIGINT.
 * @module index
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import alertRoutes from './routes/alerts.js';
import adminRoutes from './routes/admin.js';
import { errorHandler, notFoundHandler, requestLogger } from './middleware/error.js';
import logger from './utils/logger.js';
import pool from './db/pool.js';
import redis from './db/redis.js';
import { getMetrics, getContentType, httpRequestsTotal, httpRequestDuration } from './shared/metrics.js';
import { getCircuitBreakerStates } from './shared/resilience.js';
import { _getPriceHistoryStats, getRetentionConfig } from './shared/retention.js';

dotenv.config();

/** Express application instance */
const app = express();

/** Server port from environment or default to 3000 */
const PORT = process.env.PORT || 3000;

/** Service start time for uptime calculation */
const startTime = Date.now();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(requestLogger);

// Prometheus metrics middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = req.route?.path || req.path;

    // Normalize path to avoid high cardinality
    const normalizedPath = path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
      .replace(/\/\d+/g, '/:id');

    httpRequestsTotal.labels(req.method, normalizedPath, String(res.statusCode)).inc();
    httpRequestDuration.labels(req.method, normalizedPath).observe(duration);
  });

  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', limiter);

/**
 * Prometheus metrics endpoint.
 * Exposes all application metrics in Prometheus text format.
 * Accessible without authentication for scraping by monitoring systems.
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error, action: 'metrics_error' }, 'Failed to collect metrics');
    res.status(500).send('Error collecting metrics');
  }
});

/**
 * Basic health check endpoint for load balancers.
 * Returns 200 if the service is running, regardless of dependency status.
 * Use /health/detailed for full dependency checks.
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Detailed health check endpoint for monitoring and debugging.
 * Verifies database and Redis connectivity, reports component status.
 * Returns 503 if any critical dependency is unhealthy.
 */
app.get('/health/detailed', async (req, res) => {
  const checks: Record<string, {
    status: 'healthy' | 'unhealthy' | 'degraded';
    latencyMs?: number;
    message?: string;
  }> = {};

  let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';

  // Check database connection
  try {
    const dbStart = Date.now();
    await pool.query('SELECT 1');
    checks.database = {
      status: 'healthy',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error) {
    checks.database = {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
    overallStatus = 'unhealthy';
  }

  // Check Redis connection
  try {
    const redisStart = Date.now();
    await redis.ping();
    checks.redis = {
      status: 'healthy',
      latencyMs: Date.now() - redisStart,
    };
  } catch (error) {
    checks.redis = {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
    overallStatus = 'unhealthy';
  }

  // Get circuit breaker states
  const circuitStates = getCircuitBreakerStates();
  const openCircuits = Object.entries(circuitStates)
    .filter(([_, state]) => state === 'open')
    .map(([domain]) => domain);

  if (openCircuits.length > 0) {
    checks.circuitBreakers = {
      status: 'degraded',
      message: `Open circuits: ${openCircuits.join(', ')}`,
    };
    if (overallStatus === 'healthy') {
      overallStatus = 'degraded';
    }
  } else {
    checks.circuitBreakers = {
      status: 'healthy',
      message: `${Object.keys(circuitStates).length} domain circuits active`,
    };
  }

  // Get retention config
  const retentionConfig = getRetentionConfig();

  // Calculate uptime
  const uptimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);

  const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: {
      seconds: uptimeSeconds,
      human: formatUptime(uptimeSeconds),
    },
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks,
    config: {
      retention: {
        fullResolutionDays: retentionConfig.fullResolutionDays,
        maxAgeDays: retentionConfig.maxAgeDays,
      },
    },
  });
});

/**
 * Readiness check endpoint for Kubernetes/container orchestration.
 * Returns 503 until the service is ready to accept traffic.
 */
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error instanceof Error ? error.message : 'Service not ready',
    });
  }
});

/**
 * Liveness check endpoint for Kubernetes.
 * Returns 200 if the process is running.
 */
app.get('/live', (req, res) => {
  res.json({ alive: true });
});

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/alerts', alertRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Formats uptime seconds into human-readable string.
 * @param seconds - Total seconds of uptime
 * @returns Formatted string like "2d 5h 30m 15s"
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

/**
 * Graceful shutdown handler.
 * Closes database and Redis connections before exiting.
 */
async function shutdown() {
  logger.info({ action: 'shutdown_start' }, 'Shutting down gracefully...');

  try {
    await pool.end();
    await redis.quit();
    logger.info({ action: 'shutdown_complete' }, 'Closed database and cache connections');
    process.exit(0);
  } catch (error) {
    logger.error({ error, action: 'shutdown_error' }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
app.listen(PORT, () => {
  logger.info({ port: PORT, action: 'server_start' }, `Server running on port ${PORT}`);
  logger.info({ env: process.env.NODE_ENV || 'development' }, `Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
