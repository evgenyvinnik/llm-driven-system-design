import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

/**
 * Payment System API Server
 *
 * Main entry point for the payment processing backend.
 * Configures Express with middleware, routes, and graceful shutdown.
 *
 * FEATURES:
 * - Structured JSON logging with Pino
 * - Prometheus metrics at /metrics
 * - Health check with dependency status at /health
 * - Request duration metrics for all endpoints
 */

import paymentsRouter from './routes/payments.js';
import merchantsRouter from './routes/merchants.js';
import refundsRouter from './routes/refunds.js';
import chargebacksRouter from './routes/chargebacks.js';
import ledgerRouter from './routes/ledger.js';

import {
  authenticateApiKey,
  extractIdempotencyKey,
  requestLogger,
  errorHandler,
} from './middleware/auth.js';
import { closeConnections, pool, redis } from './db/connection.js';

// Import shared modules
import {
  logger,
  getMetrics,
  getMetricsContentType,
  httpRequestDuration,
  dbActiveConnections,
  processorCircuitBreaker,
  fraudCircuitBreaker,
} from './shared/index.js';

dotenv.config();

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000', 10);

// ============================================================================
// Middleware Configuration
// ============================================================================

app.use(cors());
app.use(express.json());

// Use structured logging middleware
app.use(requestLogger);

// HTTP request duration metrics middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const route = req.route?.path || req.path;
    httpRequestDuration
      .labels(req.method, route, res.statusCode.toString())
      .observe(duration);
  });

  next();
});

// ============================================================================
// Health and Metrics Endpoints
// ============================================================================

/**
 * Health check endpoint - used by load balancers and monitoring.
 * Returns detailed status of all dependencies.
 *
 * GET /health
 *
 * Response:
 * - status: 'healthy' | 'degraded' | 'unhealthy'
 * - checks: Individual dependency statuses
 * - uptime: Server uptime in seconds
 */
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

  // Check PostgreSQL
  try {
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    checks.postgres = {
      status: 'healthy',
      latency_ms: Date.now() - pgStart,
    };

    // Update connection gauge
    dbActiveConnections.set(pool.totalCount);
  } catch (error) {
    checks.postgres = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    await redis.ping();
    checks.redis = {
      status: 'healthy',
      latency_ms: Date.now() - redisStart,
    };
  } catch (error) {
    checks.redis = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check circuit breaker states
  checks.circuit_breaker_processor = {
    status: processorCircuitBreaker.getState() === 'open' ? 'degraded' : 'healthy',
  };

  checks.circuit_breaker_fraud = {
    status: fraudCircuitBreaker.getState() === 'open' ? 'degraded' : 'healthy',
  };

  // Determine overall health
  const hasUnhealthy = Object.values(checks).some((c) => c.status === 'unhealthy');
  const hasDegraded = Object.values(checks).some((c) => c.status === 'degraded');

  const overallStatus = hasUnhealthy ? 'unhealthy' : hasDegraded ? 'degraded' : 'healthy';
  const statusCode = hasUnhealthy ? 503 : 200;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    latency_ms: Date.now() - startTime,
    checks,
    version: process.env.npm_package_version || '1.0.0',
    node_version: process.version,
  });
});

/**
 * Liveness probe - minimal check for Kubernetes.
 * Only checks if the process is running.
 *
 * GET /health/live
 */
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Readiness probe - checks if the service can accept traffic.
 * Verifies database connectivity.
 *
 * GET /health/ready
 */
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Prometheus metrics endpoint.
 * Exposes all collected metrics in Prometheus text format.
 *
 * GET /metrics
 *
 * Metrics include:
 * - HTTP request duration histograms
 * - Payment transaction counters by status
 * - Fraud detection score distributions
 * - Circuit breaker states
 * - Database and Redis connection metrics
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to collect metrics');
    res.status(500).send('Failed to collect metrics');
  }
});

// ============================================================================
// Routes
// ============================================================================

// Public endpoints - merchant signup doesn't require auth
app.post('/api/v1/merchants', merchantsRouter);

// Protected endpoints - all require API key authentication
app.use('/api/v1/payments', extractIdempotencyKey, authenticateApiKey, paymentsRouter);
app.use('/api/v1/merchants', authenticateApiKey, merchantsRouter);
app.use('/api/v1/refunds', authenticateApiKey, refundsRouter);
app.use('/api/v1/chargebacks', authenticateApiKey, chargebacksRouter);
app.use('/api/v1/ledger', authenticateApiKey, ledgerRouter);

// ============================================================================
// Error Handling
// ============================================================================

app.use(errorHandler);

/** 404 handler for unmatched routes */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ============================================================================
// Server Startup
// ============================================================================

const server = app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
    },
    `Payment System API running on port ${PORT}`
  );
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`Metrics: http://localhost:${PORT}/metrics`);
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Handles graceful shutdown on SIGTERM/SIGINT signals.
 * Closes HTTP server and database connections cleanly.
 */
async function shutdown() {
  logger.info('Shutting down gracefully...');

  // Stop accepting new connections
  server.close(async () => {
    try {
      await closeConnections();
      logger.info('All connections closed successfully');
      process.exit(0);
    } catch (error) {
      logger.error({ error }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

export default app;
