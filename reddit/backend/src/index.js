import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';

import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import subredditRoutes from './routes/subreddits.js';
import postRoutes from './routes/posts.js';
import commentRoutes from './routes/comments.js';
import voteRoutes from './routes/votes.js';

// Shared modules
import logger, { requestLoggerMiddleware } from './shared/logger.js';
import { register, metricsMiddleware } from './shared/metrics.js';
import pool from './db/index.js';
import redis from './db/redis.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Track server state for graceful shutdown
let isShuttingDown = false;

// ============================================================================
// Middleware
// ============================================================================

// Reject requests during shutdown
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({
      error: 'Server is shutting down',
      retryAfter: 5,
    });
  }
  next();
});

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Structured logging middleware
app.use(requestLoggerMiddleware);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Authentication middleware
app.use(authenticate);

// ============================================================================
// Health and Metrics Endpoints
// ============================================================================

/**
 * Prometheus metrics endpoint.
 *
 * Why metrics enable hot post detection and spam prevention:
 * - Vote velocity metrics identify suddenly popular content for "rising" feeds
 * - Unusual vote patterns (high rate from few accounts) indicate potential brigading
 * - Request latency histograms surface performance degradation
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics');
    res.status(500).end();
  }
});

/**
 * Enhanced health check endpoint.
 *
 * Returns detailed status of all dependencies for:
 * - Load balancer health checks (use /health/live for simple check)
 * - Debugging connectivity issues
 * - Monitoring dashboard integration
 */
app.get('/health', async (req, res) => {
  const checks = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: process.env.SERVICE_NAME || 'reddit-api',
    version: process.env.npm_package_version || '1.0.0',
    checks: {},
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.checks.postgres = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    checks.checks.postgres = {
      status: 'error',
      error: error.message,
    };
    checks.status = 'degraded';
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    checks.checks.redis = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    checks.checks.redis = {
      status: 'error',
      error: error.message,
    };
    checks.status = 'degraded';
  }

  // Memory usage
  const memUsage = process.memoryUsage();
  checks.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024),
  };

  const statusCode = checks.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(checks);
});

/**
 * Simple liveness probe for Kubernetes/load balancers.
 * Returns 200 if the process is running, regardless of dependencies.
 */
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Readiness probe - only returns 200 if all dependencies are healthy.
 */
app.get('/health/ready', async (req, res) => {
  try {
    await Promise.all([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// ============================================================================
// API Routes
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/subreddits', subredditRoutes);
app.use('/api/posts', postRoutes);
app.use('/api', commentRoutes);
app.use('/api/vote', voteRoutes);

// Convenience routes for r/subreddit pattern
app.use('/api/r', subredditRoutes);

// ============================================================================
// Error Handling
// ============================================================================

app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({
    err,
    method: req.method,
    path: req.path,
    userId: req.user?.id,
  }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// Server Startup
// ============================================================================

const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
  }, `Reddit API server started`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`Metrics: http://localhost:${PORT}/metrics`);
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Why graceful shutdown prevents data loss:
 * - In-flight requests complete before server stops accepting new connections
 * - Background workers (vote aggregation) finish current batch
 * - Database connections are properly closed, preventing orphaned transactions
 * - Redis connections are flushed, ensuring cached votes are persisted
 */

const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS, 10) || 30000;

async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  isShuttingDown = true;

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Close database connections
      await pool.end();
      logger.info('PostgreSQL connection pool closed');

      // Close Redis connection
      await redis.quit();
      logger.info('Redis connection closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during graceful shutdown');
      process.exit(1);
    }
  });

  // Force shutdown after timeout
  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled promise rejection');
});

export default app;
