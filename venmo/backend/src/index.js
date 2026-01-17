const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

// Import shared modules
const { logger } = require('./shared/logger');
const { register, metricsMiddleware, updatePoolMetrics } = require('./shared/metrics');
const { pool } = require('./db/pool');
const { redis } = require('./db/redis');
const { getStorageStats, RETENTION_CONFIG } = require('./shared/archival');
const { bankApiCircuit, cardNetworkCircuit, achNetworkCircuit } = require('./shared/circuit-breaker');

// Import routes
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const transferRoutes = require('./routes/transfers');
const requestRoutes = require('./routes/requests');
const feedRoutes = require('./routes/feed');
const friendsRoutes = require('./routes/friends');
const paymentMethodsRoutes = require('./routes/paymentMethods');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE
// ============================================================================

// CORS configuration
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
}));

// Parse JSON bodies
app.use(express.json());

// Request ID middleware - adds unique ID for request tracing
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('x-request-id', req.requestId);
  next();
});

// Prometheus metrics middleware - tracks request latency and counts
app.use(metricsMiddleware);

// Structured request logging with pino
app.use((req, res, next) => {
  const startTime = Date.now();

  // Log request
  logger.info({
    event: 'request_received',
    requestId: req.requestId,
    method: req.method,
    url: req.url,
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.headers['x-forwarded-for'],
  });

  // Log response on finish
  res.on('finish', () => {
    const durationMs = Date.now() - startTime;
    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    logger[logLevel]({
      event: 'request_completed',
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      durationMs,
    });
  });

  next();
});

// ============================================================================
// HEALTH CHECK ENDPOINT
// ============================================================================

/**
 * Basic health check - returns 200 if server is running
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'venmo-api',
    version: process.env.npm_package_version || '1.0.0',
  });
});

/**
 * Detailed health check - checks all dependencies
 * Use this for load balancer health checks with longer intervals
 */
app.get('/health/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'venmo-api',
    uptime: process.uptime(),
    checks: {},
  };

  // Check PostgreSQL
  try {
    const startDb = Date.now();
    await pool.query('SELECT 1');
    health.checks.postgres = {
      status: 'ok',
      latencyMs: Date.now() - startDb,
    };
  } catch (error) {
    health.status = 'degraded';
    health.checks.postgres = {
      status: 'error',
      error: error.message,
    };
  }

  // Check Redis
  try {
    const startRedis = Date.now();
    await redis.ping();
    health.checks.redis = {
      status: 'ok',
      latencyMs: Date.now() - startRedis,
    };
  } catch (error) {
    health.status = 'degraded';
    health.checks.redis = {
      status: 'error',
      error: error.message,
    };
  }

  // Check circuit breakers
  health.checks.circuitBreakers = {
    bankApi: bankApiCircuit.getStats(),
    cardNetwork: cardNetworkCircuit.getStats(),
    achNetwork: achNetworkCircuit.getStats(),
  };

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024),
  };

  // Connection pool stats
  updatePoolMetrics(pool);
  health.checks.connectionPool = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };

  // Return appropriate status code
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Liveness probe - for Kubernetes
 * Returns 200 if the process is alive
 */
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness probe - for Kubernetes
 * Returns 200 if ready to accept traffic
 */
app.get('/health/ready', async (req, res) => {
  try {
    // Quick check of critical dependencies
    await Promise.all([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// ============================================================================
// PROMETHEUS METRICS ENDPOINT
// ============================================================================

/**
 * Prometheus metrics endpoint
 *
 * Exposes metrics in Prometheus format for scraping:
 * - HTTP request latency and counts
 * - Transfer metrics (success, failure, amounts)
 * - Database connection pool stats
 * - Circuit breaker states
 * - Node.js runtime metrics
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update pool metrics before serving
    updatePoolMetrics(pool);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({
      event: 'metrics_error',
      error: error.message,
    });
    res.status(500).end(error.message);
  }
});

// ============================================================================
// ADMIN/DEBUG ENDPOINTS
// ============================================================================

/**
 * Storage statistics - for monitoring data growth
 */
app.get('/admin/storage-stats', async (req, res) => {
  try {
    const stats = await getStorageStats();
    res.json({
      stats,
      retentionConfig: RETENTION_CONFIG,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({
      event: 'storage_stats_error',
      error: error.message,
    });
    res.status(500).json({ error: 'Failed to get storage stats' });
  }
});

/**
 * Circuit breaker status - for debugging
 */
app.get('/admin/circuit-breakers', (req, res) => {
  res.json({
    bankApi: bankApiCircuit.getStats(),
    cardNetwork: cardNetworkCircuit.getStats(),
    achNetwork: achNetworkCircuit.getStats(),
  });
});

// ============================================================================
// API ROUTES
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/transfers', transferRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/friends', friendsRoutes);
app.use('/api/payment-methods', paymentMethodsRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

// Global error handler
app.use((err, req, res, next) => {
  logger.error({
    event: 'unhandled_error',
    requestId: req.requestId,
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId,
  });
});

// 404 handler
app.use((req, res) => {
  logger.warn({
    event: 'route_not_found',
    requestId: req.requestId,
    url: req.url,
    method: req.method,
  });

  res.status(404).json({
    error: 'Not found',
    requestId: req.requestId,
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  logger.info({
    event: 'server_started',
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
    pid: process.pid,
  });

  console.log(`Venmo API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info({ event: 'shutdown_initiated', signal: 'SIGTERM' });

  // Close database pool
  await pool.end();
  await redis.quit();

  logger.info({ event: 'shutdown_complete' });
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info({ event: 'shutdown_initiated', signal: 'SIGINT' });

  await pool.end();
  await redis.quit();

  logger.info({ event: 'shutdown_complete' });
  process.exit(0);
});

module.exports = app;
